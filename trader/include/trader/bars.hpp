// The bar cache: a dense, columnar, memory-mapped price series.
//
// Layout decisions, and why each one is the way it is.
//
// Dense grid, no timestamp column. Bars sit on a fixed interval, so a bar's
// open time is arithmetic on its index rather than a lookup. That drops eight
// bytes per bar and turns every "where is 14:00 on the 3rd" from a binary
// search into a subtraction.
//
// Missing bars are NaN, not absent. Binance genuinely has holes - maintenance
// windows, and listings whose first minutes were never recorded. Packing the
// present bars shoulder to shoulder would let a strategy trade straight across
// a halt at prices that never existed, and nothing would complain. A NaN
// propagates instead, loudly.
//
//     Do not build this with -ffast-math. It tells the compiler NaN cannot
//     happen, and the gap representation is built out of NaN.
//
// Columns, not rows. A strategy reading only closes touches an eighth of the
// bytes a row layout would drag through cache. On a chip with a large L3 that
// is the difference between a sweep that streams from RAM and one that does
// not leave the die.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#include "trader/mapping.hpp"

namespace trader {

inline constexpr char kBarMagic[8] = {'T', 'R', 'D', 'R', 'B', 'A', 'R', '1'};
inline constexpr std::uint32_t kBarVersion = 1;
inline constexpr std::size_t kColumnAlign = 64;

class CacheError : public std::runtime_error {
public:
    explicit CacheError(const std::string& what) : std::runtime_error(what) {}
};

#pragma pack(push, 1)
struct BarHeader {
    char magic[8];
    std::uint32_t version;
    std::uint32_t interval_ms;      // 60000 for 1m; fits comfortably in 32 bits
    char symbol[24];                // nul-padded, e.g. "BTCUSDT"
    std::int64_t first_open_ms;     // open time of index 0
    std::uint64_t count;            // grid slots, including the NaN ones
    std::uint64_t present;          // slots that actually carry a bar
    std::uint64_t checksum;         // FNV-1a over the column bytes
    std::uint64_t reserved[7];   // 72 bytes of fields, 56 spare, 128 total
};
#pragma pack(pop)

static_assert(sizeof(BarHeader) == 128, "header must stay a fixed 128 bytes");

inline std::size_t align_up(std::size_t value, std::size_t to) noexcept {
    return (value + to - 1) / to * to;
}

inline std::uint64_t fnv1a(const void* data, std::size_t bytes, std::uint64_t seed = 1469598103934665603ULL) noexcept {
    const auto* p = static_cast<const unsigned char*>(data);
    std::uint64_t hash = seed;
    for (std::size_t i = 0; i < bytes; ++i) {
        hash ^= p[i];
        hash *= 1099511628211ULL;
    }
    return hash;
}

// A borrowed view over one symbol's bars. Copyable, non-owning, trivially
// cheap to hand to a thread.
struct BarSeries {
    const double* open = nullptr;
    const double* high = nullptr;
    const double* low = nullptr;
    const double* close = nullptr;
    const float* volume = nullptr;
    const std::uint32_t* trades = nullptr;

    std::size_t count = 0;
    std::int64_t first_open_ms = 0;
    std::int64_t interval_ms = 0;
    std::string symbol;

    std::int64_t time_at(std::size_t i) const noexcept {
        return first_open_ms + static_cast<std::int64_t>(i) * interval_ms;
    }

    // The instant this bar finished. A strategy standing on bar i knows this
    // much and not one millisecond more.
    std::int64_t close_time_at(std::size_t i) const noexcept {
        return time_at(i) + interval_ms;
    }

    // Grid slot for a wall-clock instant. Unchecked on purpose: callers in the
    // hot loop already know their range, and the checked version is below.
    std::size_t index_at(std::int64_t ms) const noexcept {
        return static_cast<std::size_t>((ms - first_open_ms) / interval_ms);
    }

    bool contains(std::int64_t ms) const noexcept {
        return ms >= first_open_ms && ms < time_at(count);
    }

    // NaN compares unequal to itself, which is the cheapest possible test and
    // needs no library call. It is also why -ffast-math is forbidden here.
    bool present(std::size_t i) const noexcept { return close[i] == close[i]; }

    std::size_t bytes() const noexcept { return count * (4 * sizeof(double) + sizeof(float) + sizeof(std::uint32_t)); }
};

// Owns the mapping and hands out views onto it.
class BarCache {
public:
    BarCache() = default;

    explicit BarCache(const std::string& path) : mapping_(path) { parse(path); }

    const BarSeries& series() const noexcept { return series_; }
    const BarHeader& header() const noexcept { return *header_; }

    // Recompute the payload hash and compare. Cheap insurance against a cache
    // truncated by a killed fetch, which otherwise reads as a shorter, valid,
    // completely wrong history.
    bool verify() const {
        const std::size_t payload = mapping_.size() - align_up(sizeof(BarHeader), kColumnAlign);
        const auto* start = mapping_.data() + align_up(sizeof(BarHeader), kColumnAlign);
        return fnv1a(start, payload) == header_->checksum;
    }

private:
    void parse(const std::string& path) {
        if (mapping_.size() < sizeof(BarHeader)) {
            throw CacheError(path + ": too small to hold a header");
        }

        header_ = reinterpret_cast<const BarHeader*>(mapping_.data());
        if (std::memcmp(header_->magic, kBarMagic, sizeof(kBarMagic)) != 0) {
            throw CacheError(path + ": not a bar cache");
        }
        if (header_->version != kBarVersion) {
            throw CacheError(path + ": cache version " + std::to_string(header_->version) +
                             ", this build speaks " + std::to_string(kBarVersion));
        }

        const std::size_t count = static_cast<std::size_t>(header_->count);
        std::size_t offset = align_up(sizeof(BarHeader), kColumnAlign);

        auto take = [&](std::size_t element) -> const std::byte* {
            const std::byte* at = mapping_.data() + offset;
            offset = align_up(offset + count * element, kColumnAlign);
            if (offset > mapping_.size()) {
                throw CacheError(path + ": truncated; header claims " +
                                 std::to_string(count) + " bars");
            }
            return at;
        };

        series_.open = reinterpret_cast<const double*>(take(sizeof(double)));
        series_.high = reinterpret_cast<const double*>(take(sizeof(double)));
        series_.low = reinterpret_cast<const double*>(take(sizeof(double)));
        series_.close = reinterpret_cast<const double*>(take(sizeof(double)));
        series_.volume = reinterpret_cast<const float*>(take(sizeof(float)));
        series_.trades = reinterpret_cast<const std::uint32_t*>(take(sizeof(std::uint32_t)));

        series_.count = count;
        series_.first_open_ms = header_->first_open_ms;
        series_.interval_ms = header_->interval_ms;
        series_.symbol.assign(header_->symbol, ::strnlen(header_->symbol, sizeof(header_->symbol)));

        mapping_.will_read_sequentially();
    }

    Mapping mapping_;
    const BarHeader* header_ = nullptr;
    BarSeries series_;
};

// One parsed bar on its way into the cache. The fetcher speaks this; nothing
// downstream does.
struct RawBar {
    std::int64_t open_time_ms;
    double open, high, low, close;
    float volume;
    std::uint32_t trades;
};

// Places bars onto the dense grid and writes the cache file.
//
// Out-of-order and duplicate bars are fine - the archives overlap at month
// boundaries - because everything is addressed by its grid slot. Last write
// wins, which is what you want when the live tail restates a bar the archive
// had recorded early.
class BarWriter {
public:
    BarWriter(std::string symbol, std::int64_t interval_ms,
              std::int64_t first_open_ms, std::size_t count)
        : symbol_(std::move(symbol)),
          interval_ms_(interval_ms),
          first_open_ms_(first_open_ms),
          count_(count),
          open_(count, nan()), high_(count, nan()), low_(count, nan()),
          close_(count, nan()), volume_(count, 0.0f), trades_(count, 0) {}

    void put(const RawBar& bar) {
        const std::int64_t delta = bar.open_time_ms - first_open_ms_;
        if (delta < 0 || delta % interval_ms_ != 0) {
            ++off_grid_;                       // a bar that is not on our grid at all
            return;
        }
        const auto slot = static_cast<std::size_t>(delta / interval_ms_);
        if (slot >= count_) {
            ++out_of_range_;
            return;
        }
        if (close_[slot] != close_[slot]) {    // first time this slot is filled
            ++present_;
        }
        open_[slot] = bar.open;
        high_[slot] = bar.high;
        low_[slot] = bar.low;
        close_[slot] = bar.close;
        volume_[slot] = bar.volume;
        trades_[slot] = bar.trades;
    }

    std::size_t present() const noexcept { return present_; }
    std::size_t count() const noexcept { return count_; }
    std::size_t off_grid() const noexcept { return off_grid_; }
    std::size_t out_of_range() const noexcept { return out_of_range_; }

    void write(const std::string& path) const;

private:
    static double nan() noexcept { return std::numeric_limits<double>::quiet_NaN(); }

    std::string symbol_;
    std::int64_t interval_ms_;
    std::int64_t first_open_ms_;
    std::size_t count_;

    std::vector<double> open_, high_, low_, close_;
    std::vector<float> volume_;
    std::vector<std::uint32_t> trades_;

    std::size_t present_ = 0;
    std::size_t off_grid_ = 0;
    std::size_t out_of_range_ = 0;
};

}  // namespace trader
