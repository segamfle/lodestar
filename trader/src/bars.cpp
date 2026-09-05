#include "trader/bars.hpp"

#include <array>
#include <cstdio>
#include <filesystem>
#include <fstream>

namespace trader {
namespace {

// Padding between columns is hashed along with the data, so it has to be
// deterministic. Zeros, always.
const std::array<std::byte, kColumnAlign> kZeros{};

struct Sink {
    std::ofstream out;
    std::uint64_t hash = 1469598103934665603ULL;
    std::size_t written = 0;

    void raw(const void* data, std::size_t bytes) {
        out.write(static_cast<const char*>(data), static_cast<std::streamsize>(bytes));
        written += bytes;
    }

    void hashed(const void* data, std::size_t bytes) {
        hash = fnv1a(data, bytes, hash);
        raw(data, bytes);
    }

    void pad_to(std::size_t boundary) {
        const std::size_t target = align_up(written, boundary);
        if (target > written) {
            hashed(kZeros.data(), target - written);
        }
    }
};

}  // namespace

void BarWriter::write(const std::string& path) const {
    // Write beside the target and rename into place. A fetch killed halfway
    // then leaves a stray .tmp rather than a half-written cache that still
    // carries a valid magic number.
    const std::filesystem::path final_path(path);
    const std::filesystem::path temp_path = final_path.string() + ".tmp";

    if (final_path.has_parent_path()) {
        std::filesystem::create_directories(final_path.parent_path());
    }

    {
        Sink sink{std::ofstream(temp_path, std::ios::binary | std::ios::trunc)};
        if (!sink.out) {
            throw CacheError("cannot write " + temp_path.string());
        }

        BarHeader header{};
        std::memcpy(header.magic, kBarMagic, sizeof(kBarMagic));
        header.version = kBarVersion;
        header.interval_ms = static_cast<std::uint32_t>(interval_ms_);
        // memcpy rather than strncpy: the field is already zeroed, the bound is
        // ours, and the CRT deprecation warning buys nothing here.
        const std::size_t name_length = std::min(symbol_.size(), sizeof(header.symbol) - 1);
        std::memcpy(header.symbol, symbol_.data(), name_length);
        header.first_open_ms = first_open_ms_;
        header.count = count_;
        header.present = present_;
        header.checksum = 0;  // patched below, once the payload has been hashed

        sink.raw(&header, sizeof(header));

        // The header itself is outside the hashed region, because the hash it
        // carries cannot cover itself.
        const std::size_t payload_start = align_up(sizeof(BarHeader), kColumnAlign);
        if (payload_start > sink.written) {
            sink.raw(kZeros.data(), payload_start - sink.written);
        }
        sink.hash = 1469598103934665603ULL;

        auto column = [&](const void* data, std::size_t bytes) {
            sink.hashed(data, bytes);
            sink.pad_to(kColumnAlign);
        };

        column(open_.data(), count_ * sizeof(double));
        column(high_.data(), count_ * sizeof(double));
        column(low_.data(), count_ * sizeof(double));
        column(close_.data(), count_ * sizeof(double));
        column(volume_.data(), count_ * sizeof(float));
        column(trades_.data(), count_ * sizeof(std::uint32_t));

        header.checksum = sink.hash;

        sink.out.flush();
        if (!sink.out) {
            throw CacheError("write failed for " + temp_path.string());
        }
        sink.out.seekp(0);
        sink.out.write(reinterpret_cast<const char*>(&header), sizeof(header));
        sink.out.close();
        if (!sink.out) {
            throw CacheError("could not finalise " + temp_path.string());
        }
    }

    // One atomic replace, and no fallback. The obvious fallback - remove the
    // old file, then rename - has a window where the remove succeeds and the
    // rename does not, which destroys a good cache to install nothing. On
    // Windows this rename is MoveFileEx with MOVEFILE_REPLACE_EXISTING, so
    // there is nothing to fall back to anyway.
    std::error_code error;
    std::filesystem::rename(temp_path, final_path, error);
    if (error) {
        throw CacheError("cannot move cache into place (" + error.message() +
                         "); the new data is at " + temp_path.string());
    }
}

}  // namespace trader
