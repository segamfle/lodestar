// Read-only memory mapping of a file.
//
// The bar cache is read far more often than it is written - every parameter in
// a sweep walks the same arrays - so the loader must not parse, decompress or
// even copy. Mapping the file hands the pages straight to the CPU and lets the
// OS keep them resident across runs, which is why a sweep's second invocation
// starts instantly.

#pragma once

#include <cstddef>
#include <stdexcept>
#include <string>
#include <utility>

#if defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#else
#  include <fcntl.h>
#  include <sys/mman.h>
#  include <sys/stat.h>
#  include <unistd.h>
#endif

namespace trader {

class MapError : public std::runtime_error {
public:
    explicit MapError(const std::string& what) : std::runtime_error(what) {}
};

class Mapping {
public:
    Mapping() = default;

    explicit Mapping(const std::string& path) { open(path); }

    Mapping(const Mapping&) = delete;
    Mapping& operator=(const Mapping&) = delete;

    Mapping(Mapping&& other) noexcept { swap(other); }

    Mapping& operator=(Mapping&& other) noexcept {
        if (this != &other) {
            close();
            swap(other);
        }
        return *this;
    }

    ~Mapping() { close(); }

    const std::byte* data() const noexcept { return base_; }
    std::size_t size() const noexcept { return size_; }
    bool valid() const noexcept { return base_ != nullptr; }

    // Tell the OS we are about to walk the whole thing front to back. On a
    // cold cache this turns a few thousand demand faults into one readahead.
    void will_read_sequentially() const noexcept {
#if !defined(_WIN32)
        if (base_ != nullptr) {
            ::madvise(const_cast<std::byte*>(base_), size_, MADV_SEQUENTIAL | MADV_WILLNEED);
        }
#endif
    }

private:
    void open(const std::string& path) {
#if defined(_WIN32)
        // FILE_SHARE_DELETE matters more than it looks. Without it, a running
        // backtest holding a cache mapped stops the fetcher from replacing that
        // cache at all - Windows refuses both the delete and the rename. With
        // it, the replacement goes through and this mapping keeps serving the
        // pages it already has, which is exactly POSIX unlink semantics: the
        // reader finishes on the old bytes and picks up the new ones when it
        // next opens the file.
        file_ = ::CreateFileA(path.c_str(), GENERIC_READ,
                              FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file_ == INVALID_HANDLE_VALUE) {
            throw MapError("cannot open " + path);
        }

        LARGE_INTEGER length{};
        if (!::GetFileSizeEx(file_, &length)) {
            ::CloseHandle(file_);
            file_ = INVALID_HANDLE_VALUE;
            throw MapError("cannot size " + path);
        }
        size_ = static_cast<std::size_t>(length.QuadPart);
        if (size_ == 0) {
            ::CloseHandle(file_);
            file_ = INVALID_HANDLE_VALUE;
            throw MapError("empty file " + path);
        }

        section_ = ::CreateFileMappingA(file_, nullptr, PAGE_READONLY, 0, 0, nullptr);
        if (section_ == nullptr) {
            ::CloseHandle(file_);
            file_ = INVALID_HANDLE_VALUE;
            throw MapError("cannot map " + path);
        }

        base_ = static_cast<const std::byte*>(::MapViewOfFile(section_, FILE_MAP_READ, 0, 0, 0));
        if (base_ == nullptr) {
            ::CloseHandle(section_);
            ::CloseHandle(file_);
            section_ = nullptr;
            file_ = INVALID_HANDLE_VALUE;
            throw MapError("cannot view " + path);
        }
#else
        fd_ = ::open(path.c_str(), O_RDONLY);
        if (fd_ < 0) {
            throw MapError("cannot open " + path);
        }

        struct stat info {};
        if (::fstat(fd_, &info) != 0 || info.st_size == 0) {
            ::close(fd_);
            fd_ = -1;
            throw MapError("cannot size " + path);
        }
        size_ = static_cast<std::size_t>(info.st_size);

        void* view = ::mmap(nullptr, size_, PROT_READ, MAP_PRIVATE, fd_, 0);
        if (view == MAP_FAILED) {
            ::close(fd_);
            fd_ = -1;
            throw MapError("cannot map " + path);
        }
        base_ = static_cast<const std::byte*>(view);
#endif
    }

    void close() noexcept {
#if defined(_WIN32)
        if (base_ != nullptr) { ::UnmapViewOfFile(base_); }
        if (section_ != nullptr) { ::CloseHandle(section_); }
        if (file_ != INVALID_HANDLE_VALUE) { ::CloseHandle(file_); }
        base_ = nullptr;
        section_ = nullptr;
        file_ = INVALID_HANDLE_VALUE;
#else
        if (base_ != nullptr) { ::munmap(const_cast<std::byte*>(base_), size_); }
        if (fd_ >= 0) { ::close(fd_); }
        base_ = nullptr;
        fd_ = -1;
#endif
        size_ = 0;
    }

    void swap(Mapping& other) noexcept {
        std::swap(base_, other.base_);
        std::swap(size_, other.size_);
#if defined(_WIN32)
        std::swap(file_, other.file_);
        std::swap(section_, other.section_);
#else
        std::swap(fd_, other.fd_);
#endif
    }

    const std::byte* base_ = nullptr;
    std::size_t size_ = 0;
#if defined(_WIN32)
    HANDLE file_ = INVALID_HANDLE_VALUE;
    HANDLE section_ = nullptr;
#else
    int fd_ = -1;
#endif
};

}  // namespace trader
