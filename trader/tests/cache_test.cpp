// Round-trip and integrity checks for the bar cache.
//
// The cache is the floor everything else stands on. If a gap can be written
// and read back as a real bar, every result above it is fiction, and the
// failure is silent - the equity curve just comes out slightly too good.

#include "trader/bars.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace {

int failures = 0;
int checks = 0;

void check(bool condition, const std::string& what) {
    ++checks;
    if (!condition) {
        ++failures;
        std::printf("  FAIL  %s\n", what.c_str());
    }
}

constexpr std::int64_t kMinute = 60'000;
constexpr std::int64_t kEpoch = 1'750'000'000'000;  // an arbitrary round instant

std::filesystem::path scratch(const std::string& name) {
    return std::filesystem::temp_directory_path() / name;
}

// A hundred minutes of bars with two holes punched in: one single missing bar
// at slot 10, one three-bar run at slots 40..42.
trader::BarWriter build_series(std::size_t count = 100) {
    trader::BarWriter writer("BTCUSDT", kMinute, kEpoch, count);
    for (std::size_t i = 0; i < count; ++i) {
        if (i == 10 || (i >= 40 && i <= 42)) {
            continue;
        }
        const double price = 60'000.0 + static_cast<double>(i);
        writer.put(trader::RawBar{
            .open_time_ms = kEpoch + static_cast<std::int64_t>(i) * kMinute,
            .open = price,
            .high = price + 5.0,
            .low = price - 5.0,
            .close = price + 1.0,
            .volume = static_cast<float>(i) * 0.5f,
            .trades = static_cast<std::uint32_t>(i),
        });
    }
    return writer;
}

void test_roundtrip() {
    std::printf("roundtrip\n");
    const auto path = scratch("trader_roundtrip.tbars");
    const auto writer = build_series();

    check(writer.count() == 100, "grid holds every slot including the empty ones");
    check(writer.present() == 96, "four slots were left unfilled");

    writer.write(path.string());
    const trader::BarCache cache(path.string());
    const auto& bars = cache.series();

    check(cache.verify(), "checksum matches what was written");
    check(bars.symbol == "BTCUSDT", "symbol survives the round trip");
    check(bars.count == 100, "count survives");
    check(bars.interval_ms == kMinute, "interval survives");
    check(bars.first_open_ms == kEpoch, "start instant survives");
    check(cache.header().present == 96, "present count survives");

    check(bars.close[0] == 60'001.0, "first close is exact");
    check(bars.open[99] == 60'099.0, "last open is exact");
    check(bars.high[5] == 60'010.0, "high is exact");
    check(bars.low[5] == 60'000.0, "low is exact");
    check(bars.trades[7] == 7, "trade count survives");
    check(bars.volume[8] == 4.0f, "volume survives");

    std::filesystem::remove(path);
}

void test_gaps_stay_gaps() {
    std::printf("gaps stay gaps\n");
    const auto path = scratch("trader_gaps.tbars");
    build_series().write(path.string());

    const trader::BarCache cache(path.string());
    const auto& bars = cache.series();

    check(!bars.present(10), "the single-bar hole reads as absent");
    check(!bars.present(40) && !bars.present(41) && !bars.present(42), "the three-bar hole reads as absent");
    check(bars.present(9) && bars.present(11), "bars either side of a hole are intact");
    check(bars.close[10] != bars.close[10], "a missing close really is NaN");

    // The point of NaN over a sentinel: arithmetic on a gap poisons its result
    // rather than quietly producing a plausible number.
    const double spread = bars.high[10] - bars.low[10];
    check(spread != spread, "arithmetic across a gap yields NaN, not a plausible lie");

    std::filesystem::remove(path);
}

void test_time_arithmetic() {
    std::printf("time arithmetic\n");
    const auto path = scratch("trader_time.tbars");
    build_series().write(path.string());

    const trader::BarCache cache(path.string());
    const auto& bars = cache.series();

    check(bars.time_at(0) == kEpoch, "slot zero opens at the epoch");
    check(bars.time_at(37) == kEpoch + 37 * kMinute, "slot time is a plain multiple");
    check(bars.close_time_at(37) == kEpoch + 38 * kMinute, "a bar closes one interval after it opens");
    check(bars.index_at(kEpoch + 37 * kMinute) == 37, "index and time are inverses");

    // Mid-bar instants belong to the bar that contains them, not the next one.
    check(bars.index_at(kEpoch + 37 * kMinute + 30'000) == 37, "an instant inside a bar maps to that bar");

    check(bars.contains(kEpoch), "the first instant is inside the range");
    check(bars.contains(kEpoch + 99 * kMinute), "the last bar's open is inside the range");
    check(!bars.contains(kEpoch + 100 * kMinute), "one past the end is outside");
    check(!bars.contains(kEpoch - 1), "one before the start is outside");

    std::filesystem::remove(path);
}

void test_out_of_order_and_duplicates() {
    std::printf("out of order and duplicates\n");
    const auto path = scratch("trader_disorder.tbars");

    // Archives overlap at month boundaries and the live tail restates the bar
    // it had already reported, so both cases arrive in normal use.
    trader::BarWriter writer("ETHUSDT", kMinute, kEpoch, 10);
    auto bar = [](std::size_t slot, double close) {
        return trader::RawBar{kEpoch + static_cast<std::int64_t>(slot) * kMinute,
                              close, close, close, close, 1.0f, 1};
    };

    writer.put(bar(5, 100.0));
    writer.put(bar(1, 200.0));   // arrives late
    writer.put(bar(5, 300.0));   // restates slot 5
    writer.put(bar(0, 400.0));

    check(writer.present() == 3, "a restated bar does not count twice");

    writer.write(path.string());
    const trader::BarCache cache(path.string());
    const auto& bars = cache.series();

    check(bars.close[5] == 300.0, "the last write of a slot wins");
    check(bars.close[1] == 200.0, "a late arrival lands in its own slot");
    check(bars.close[0] == 400.0, "order of arrival does not move anything");
    check(!bars.present(2), "untouched slots stay empty");

    std::filesystem::remove(path);
}

void test_off_grid_bars_are_counted() {
    std::printf("off-grid bars\n");

    trader::BarWriter writer("BTCUSDT", kMinute, kEpoch, 10);
    writer.put(trader::RawBar{kEpoch + 30'000, 1, 1, 1, 1, 1.0f, 1});          // mid-minute
    writer.put(trader::RawBar{kEpoch - kMinute, 1, 1, 1, 1, 1.0f, 1});         // before the start
    writer.put(trader::RawBar{kEpoch + 50 * kMinute, 1, 1, 1, 1, 1.0f, 1});    // past the end

    check(writer.off_grid() == 2, "bars off the interval grid are rejected and counted");
    check(writer.out_of_range() == 1, "a bar past the end is rejected and counted");
    check(writer.present() == 0, "none of them landed");
}

void test_corruption_is_caught() {
    std::printf("corruption\n");
    const auto path = scratch("trader_corrupt.tbars");
    build_series().write(path.string());

    // Flip one byte deep inside the close column.
    {
        std::fstream file(path, std::ios::binary | std::ios::in | std::ios::out);
        file.seekp(static_cast<std::streamoff>(trader::align_up(sizeof(trader::BarHeader), 64)) + 200);
        const char poison = 0x7f;
        file.write(&poison, 1);
    }

    const trader::BarCache cache(path.string());
    check(!cache.verify(), "a single flipped byte fails the checksum");

    std::filesystem::remove(path);

    // A truncated file must not read as a shorter, valid history.
    const auto short_path = scratch("trader_short.tbars");
    build_series().write(short_path.string());
    const auto full_size = std::filesystem::file_size(short_path);
    std::filesystem::resize_file(short_path, full_size / 2);

    bool threw = false;
    try {
        const trader::BarCache truncated(short_path.string());
    } catch (const trader::CacheError&) {
        threw = true;
    }
    check(threw, "a truncated cache is rejected at open, not read short");

    std::filesystem::remove(short_path);
}

void test_rejects_foreign_files() {
    std::printf("foreign files\n");
    const auto path = scratch("trader_foreign.bin");
    {
        std::ofstream out(path, std::ios::binary);
        const std::string junk(4096, 'x');
        out.write(junk.data(), static_cast<std::streamsize>(junk.size()));
    }

    bool threw = false;
    try {
        const trader::BarCache cache(path.string());
    } catch (const trader::CacheError&) {
        threw = true;
    }
    check(threw, "a file without the magic is refused");

    std::filesystem::remove(path);
}

}  // namespace

int main() {
    // Unbuffered: when a check trips a hard fault the buffered tail is lost,
    // and a test binary that dies without saying where is useless.
    std::setvbuf(stdout, nullptr, _IONBF, 0);

    test_roundtrip();
    test_gaps_stay_gaps();
    test_time_arithmetic();
    test_out_of_order_and_duplicates();
    test_off_grid_bars_are_counted();
    test_corruption_is_caught();
    test_rejects_foreign_files();

    std::printf("\n%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
