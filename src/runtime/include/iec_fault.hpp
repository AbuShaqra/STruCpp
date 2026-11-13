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
#include <string>
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
    Subrange      = 4,  ///< A value stored outside its subrange.
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
    IecSiteFault(IecFault reason, const std::string& message)
        : std::runtime_error(message), reason_(reason) {}
    IecFault reason() const noexcept { return reason_; }
private:
    IecFault reason_;
};
#endif

/** Raise `reason` at `site`, with `what` describing it ("Division by zero"). */
[[noreturn]] inline void iec_site_fault(IecFault reason, const char* what, iec_site site) {
#if STRUCPP_HAS_EXCEPTIONS
    std::string message(what);
    message += " in ";
    message += site.pou != nullptr ? site.pou : "?";
    message += ", line ";
    message += std::to_string(site.line);
    if (iec_current_task_slot() != nullptr) {
        message += ", task ";
        message += iec_current_task_slot();
    }
    throw IecSiteFault(reason, message);
#else
    (void)site;
    iec_runtime_fault(reason, what);
#endif
}

namespace detail {
inline void append_indices(std::string&) {}
template<typename I, typename... Rest>
inline void append_indices(std::string& out, I first, Rest... rest) {
    if (!out.empty() && out.back() != '[' && out.back() != ' ') out += ", ";
    out += std::to_string(static_cast<long long>(first));
    append_indices(out, rest...);
}
}  // namespace detail

/**
 * `c.at(i...)` at a known site: an index out of bounds raises IecSiteFault
 * naming the indices, the POU, the line and the task on a hosted target.
 * Built with STRUCPP_NO_BOUNDS_CHECK, arrays skip the check.
 */
template<typename C, typename... I>
inline decltype(auto) iec_at(C&& c, iec_site site, I... idx) {
#if STRUCPP_HAS_EXCEPTIONS
    try {
        return c.at(idx...);
    } catch (const std::out_of_range& e) {
        std::string what = e.what();
        what += sizeof...(I) > 1 ? ": [" : ": ";
        detail::append_indices(what, idx...);
        if (sizeof...(I) > 1) what += "]";
        iec_site_fault(IecFault::ArrayBounds, what.c_str(), site);
    }
#else
    (void)site;
    return c.at(idx...);
#endif
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
