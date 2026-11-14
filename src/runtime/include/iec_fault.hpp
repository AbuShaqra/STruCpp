// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2026 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * iec_fault.hpp — unrecoverable-fault handling for the STruC++ runtime.
 *
 * STruC++ runs on two very different classes of target:
 *
 *   - Hosted (Linux/Windows OpenPLC runtime, the REPL, the test harness):
 *     compiled WITH C++ exceptions. Runtime faults `throw`, and the host
 *     catches them — e.g. to stop the offending POU while the rest of the
 *     program keeps scanning, or to print a diagnostic and exit cleanly.
 *
 *   - Freestanding (microcontroller firmware: AVR, SAMD, RP2040, STM32, …):
 *     compiled with `-fno-exceptions`. There is nothing to catch a throw and
 *     the C++ exception runtime is dead weight (~10-15 KB of unwinder), so
 *     instead of throwing, the runtime calls `iec_runtime_fault()`.
 *
 * The selection is keyed off whether the *compiler* has exceptions enabled
 * (`STRUCPP_HAS_EXCEPTIONS`), NOT off any particular chip macro — so every
 * `-fno-exceptions` target uniformly takes the fault path with no per-board
 * flags.
 */
#pragma once

#include <cstdint>

// Are C++ exceptions available in this translation unit? GCC/Clang define
// __cpp_exceptions / __EXCEPTIONS with -fexceptions (the hosted default) and
// leave them undefined with -fno-exceptions; MSVC uses _CPPUNWIND.
#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#  define STRUCPP_HAS_EXCEPTIONS 1
#else
#  define STRUCPP_HAS_EXCEPTIONS 0
#endif

#if STRUCPP_HAS_EXCEPTIONS
#include <stdexcept>
#endif

#if defined(__GNUC__)
#  define STRUCPP_FAULT_PATH __attribute__((noinline, cold))
#else
#  define STRUCPP_FAULT_PATH
#endif

namespace strucpp {

/**
 * Reason an unrecoverable runtime fault was raised. Passed to
 * `iec_runtime_fault()` so a platform hook can react per-cause (distinct LED
 * blink code, alarm tone, log line, …).
 */
enum class IecFault : uint8_t {
    NullReference = 0,  ///< Dereferenced a NULL IEC pointer/reference.
    ArrayBounds   = 1,  ///< IEC array index out of bounds.
    BadLocation   = 2,  ///< Invalid located-variable area/size character.
    DivideByZero  = 3,  ///< Integer division by zero.
};

/** Where a fault happened: the POU and the line of its source, as compiled. */
struct iec_site {
    const char* pou;
    int line;
};

/**
 * The task running on this thread, named in a fault; nullptr outside a task.
 * A runtime that dispatches tasks sets it with strucpp_set_current_task().
 */
#ifdef STRUCPP_THREADED
inline const char*& iec_current_task_slot() noexcept {
    static thread_local const char* task = nullptr;
    return task;
}
#else
inline const char*& iec_current_task_slot() noexcept {
    static const char* task = nullptr;
    return task;
}
#endif

/** Name the task now running on this thread (nullptr: none). */
inline void strucpp_set_current_task(const char* name) noexcept {
    iec_current_task_slot() = name;
}

/**
 * Unrecoverable-fault handler for targets compiled WITHOUT exceptions — the
 * freestanding analogue of `throw`. It MUST NOT return.
 *
 * Only *declared* here. A weak default definition (provided by the firmware
 * glue) halts the CPU; a platform/VPP HAL may supply a strong definition to
 * blink a fault LED keyed off `reason`, sound an alarm, reboot, etc.
 *
 * On hosted (exception) builds this is never referenced — those code paths
 * `throw` instead — so no definition is required there.
 *
 * @param reason  what went wrong (for platform-specific signalling)
 * @param context optional human-readable context; may be nullptr
 */
[[noreturn]] void iec_runtime_fault(IecFault reason, const char* context = nullptr) noexcept;

#if STRUCPP_HAS_EXCEPTIONS
/** A run-time fault at a known site: what happened, the POU, line and task. */
class IecSiteFault : public std::runtime_error {
public:
    IecSiteFault(IecFault reason, const char* message)
        : std::runtime_error(message), reason_(reason) {}
    IecFault reason() const noexcept { return reason_; }
private:
    IecFault reason_;
};
#endif

namespace detail {

/** A fault message in a fixed buffer: no allocation, so a target without exceptions builds it too. */
class fault_text {
public:
    fault_text() noexcept { buf_[0] = '\0'; }
    fault_text& add(const char* s) noexcept {
        while (s != nullptr && *s != '\0' && len_ + 1 < sizeof(buf_)) buf_[len_++] = *s++;
        buf_[len_] = '\0';
        return *this;
    }
    fault_text& add_unsigned(unsigned long long v) noexcept {
        char digits[24];
        unsigned n = 0;
        do {
            digits[n++] = static_cast<char>('0' + v % 10);
            v /= 10;
        } while (v != 0);
        while (n > 0 && len_ + 1 < sizeof(buf_)) buf_[len_++] = digits[--n];
        buf_[len_] = '\0';
        return *this;
    }
    fault_text& add_signed(long long v) noexcept {
        if (v >= 0) return add_unsigned(static_cast<unsigned long long>(v));
        add("-");
        return add_unsigned(0ULL - static_cast<unsigned long long>(v));
    }
    /** An integer value as written, unsigned ones above 2^63 included. */
    template<typename T>
    fault_text& add_number(T v) noexcept {
        return v < static_cast<T>(0) ? add_signed(static_cast<long long>(v))
                                     : add_unsigned(static_cast<unsigned long long>(v));
    }
    const char* c_str() const noexcept { return buf_; }
    bool empty() const noexcept { return len_ == 0; }
    char back() const noexcept { return len_ == 0 ? '\0' : buf_[len_ - 1]; }
private:
    char buf_[224];
    unsigned len_ = 0;
};

}  // namespace detail

/**
 * Raise `reason`: `text` (what happened), then " in <POU>, line <n>, task <T>".
 * A hosted target throws IecSiteFault; one without exceptions passes the same
 * text to iec_runtime_fault().
 */
[[noreturn]] STRUCPP_FAULT_PATH inline void iec_raise_fault(
    IecFault reason, detail::fault_text& text, iec_site site) {
    text.add(" in ").add(site.pou != nullptr ? site.pou : "?").add(", line ");
    text.add_signed(site.line);
    if (iec_current_task_slot() != nullptr) {
        text.add(", task ").add(iec_current_task_slot());
    }
#if STRUCPP_HAS_EXCEPTIONS
    throw IecSiteFault(reason, text.c_str());
#else
    iec_runtime_fault(reason, text.c_str());
#endif
}

/** Raise `reason` at `site`, with `what` describing it ("Division by zero"). */
[[noreturn]] STRUCPP_FAULT_PATH inline void iec_site_fault(
    IecFault reason, const char* what, iec_site site) {
    detail::fault_text text;
    text.add(what);
    iec_raise_fault(reason, text, site);
}

/** An Ed. 3 `s[i]` outside the string's current length (1..LEN). */
[[noreturn]] inline void iec_string_index_fault() {
#if STRUCPP_HAS_EXCEPTIONS
    throw std::out_of_range("String index out of bounds");
#else
    iec_runtime_fault(IecFault::ArrayBounds);
#endif
}

}  // namespace strucpp
