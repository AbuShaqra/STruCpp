// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E for the runtime force table (iec_force.hpp), driven directly from C++:
 * set / clear / re-force, the bounds, cycle-boundary application through
 * ForceScope, ownership by address range, string slots and the threaded build.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

/** A main() that runs `body`; CHECK prints the failing line, the run prints "OK" when all pass. */
function program(body: string): string {
  return `
#include "iec_force.hpp"
#include <cstdio>
#include <cstring>
#include <cstdint>
using namespace strucpp;
static int failures = 0;
#define CHECK(c) do { if (!(c)) { std::printf("FAIL line %d: %s\\n", __LINE__, #c); ++failures; } } while (0)
int main() {
    force::clear_all();
${body}
    if (failures == 0) std::printf("OK\\n");
    return 0;
}
`;
}

describe.skipIf(!hasGpp)("force table (iec_force.hpp)", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-force-table-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  function run(
    testName: string,
    body: string,
    extraFlags: string[] = [],
  ): string {
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: "",
      cppCode: "",
      testName,
      mainCode: program(body),
      extraFlags,
    });
  }

  it("a force writes the value at once and is reported as forced", () => {
    const out = run(
      "force_set",
      `
    int32_t v = 1;
    const int32_t f = 42;
    CHECK(force::set(&v, &f, sizeof f) == force::Status::Ok);
    CHECK(v == 42);
    CHECK(force::is_forced(&v));
    CHECK(force::count() == 1);
    int32_t seen = 0;
    CHECK(force::read(&v, &seen, sizeof seen) == sizeof seen);
    CHECK(seen == 42);
    int32_t other = 0;
    CHECK(!force::is_forced(&other));
    CHECK(force::read(&other, &seen, sizeof seen) == 0);
`,
    );
    expect(out).toBe("OK");
  });

  it("forcing the same variable again replaces its value instead of adding a slot, across pools too", () => {
    const out = run(
      "force_reforce",
      `
    int16_t v = 0;
    const int16_t a = 1, b = 2;
    CHECK(force::set(&v, &a, sizeof a) == force::Status::Ok);
    CHECK(force::set(&v, &b, sizeof b) == force::Status::Ok);
    CHECK(force::count() == 1);
    CHECK(v == 2);
    v = 7;
    force::apply_all();
    CHECK(v == 2);
    uint8_t buf[12] = {0};
    const uint8_t wide[12] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12};
    CHECK(force::set(buf, wide, sizeof wide) == force::Status::Ok);
    const uint8_t narrow[2] = {7, 7};
    CHECK(force::set(buf, narrow, sizeof narrow) == force::Status::Ok);
    CHECK(force::count() == 2);
    buf[0] = 0; buf[11] = 0;
    force::apply_all();
    CHECK(buf[0] == 7 && buf[1] == 7 && buf[11] == 0);
    uint16_t n = 1;
    int32_t none = 0;
    CHECK(force::value_ptr(&none, &n) == nullptr && n == 0);
`,
    );
    expect(out).toBe("OK");
  });

  it("clearing a force leaves the value in place and stops applying it", () => {
    const out = run(
      "force_clear",
      `
    uint8_t v = 0;
    const uint8_t f = 9;
    force::set(&v, &f, 1);
    CHECK(force::clear(&v));
    CHECK(!force::is_forced(&v));
    CHECK(force::count() == 0);
    CHECK(v == 9);
    v = 3;
    force::apply_all();
    CHECK(v == 3);
    CHECK(!force::clear(&v));
`,
    );
    expect(out).toBe("OK");
  });

  it("refuses a force past the scalar bound, and a null or empty value", () => {
    const out = run(
      "force_bounds",
      `
    static uint8_t vars[STRUCPP_FORCE_SLOTS + 1];
    const uint8_t one = 1;
    for (int i = 0; i < STRUCPP_FORCE_SLOTS; ++i) CHECK(force::set(&vars[i], &one, 1) == force::Status::Ok);
    CHECK(force::set(&vars[STRUCPP_FORCE_SLOTS], &one, 1) == force::Status::Full);
    CHECK(force::count() == STRUCPP_FORCE_SLOTS);
    CHECK(vars[STRUCPP_FORCE_SLOTS] == 0);
    CHECK(force::set(&vars[0], &one, 1) == force::Status::Ok);
    uint8_t big[force::SCALAR_BYTES + 1] = {0};
    uint8_t target[force::SCALAR_BYTES + 1] = {0};
    CHECK(force::set(target, big, sizeof big) == force::Status::Ok);
    force::clear_all();
    CHECK(force::set(nullptr, big, 1) == force::Status::BadArgument);
    CHECK(force::set(target, big, 0) == force::Status::BadArgument);
    CHECK(force::count() == 0);
`,
    );
    expect(out).toBe("OK");
  });

  it("ForceScope applies at cycle start and again at cycle end, also on an early return", () => {
    const out = run(
      "force_scope",
      `
    struct Prog {
        int32_t x = 0;
        int32_t seen_at_start = 0;
        void run(bool early) {
            force::Scope scope(this, sizeof(*this));
            seen_at_start = x;
            x = 5;
            if (early) return;
            x = 6;
        }
    } p;
    const int32_t f = 100;
    force::set(&p.x, &f, sizeof f);
    p.x = 1;
    p.run(false);
    CHECK(p.seen_at_start == 100);
    CHECK(p.x == 100);
    p.run(true);
    CHECK(p.x == 100);
`,
    );
    expect(out).toBe("OK");
  });

  it("ForceScope re-applies when a fault unwinds the cycle", () => {
    const out = run(
      "force_scope_throw",
      `
    int32_t x = 0;
    const int32_t f = 8;
    force::set(&x, &f, sizeof f);
    try {
        force::Scope scope(&x, sizeof x);
        x = 1;
        throw 1;
    } catch (int) {}
    CHECK(x == 8);
`,
    );
    expect(out).toBe("OK");
  });

  it("a string slot holds a value larger than a scalar and uses its own apply function", () => {
    const out = run(
      "force_string",
      `
    struct Str { char data[16]; uint16_t len; };
    struct Apply {
        static void to_str(void* dst, const uint8_t* bytes, uint16_t size) {
            Str* s = static_cast<Str*>(dst);
            std::memcpy(s->data, bytes, size);
            s->len = static_cast<uint16_t>(std::strlen(s->data));
        }
    };
    Str s{};
    const char text[] = "forced string";
    CHECK(force::set(&s, text, sizeof text, 0, &Apply::to_str) == force::Status::Ok);
    CHECK(std::strcmp(s.data, "forced string") == 0 && s.len == 13);
    std::strcpy(s.data, "x"); s.len = 1;
    force::apply_all();
    CHECK(std::strcmp(s.data, "forced string") == 0 && s.len == 13);
    char buf[16] = {0};
    CHECK(force::read(&s, buf, sizeof buf) == sizeof text);
    CHECK(force::read(&s, buf, 4) == 0);
    uint16_t n = 0;
    CHECK(force::value_ptr(&s, &n) != nullptr && n == sizeof text);
    CHECK(std::strcmp(buf, "forced string") == 0);
    static Str more[STRUCPP_FORCE_STRING_SLOTS + 1];
    force::clear_all();
    for (int i = 0; i < STRUCPP_FORCE_STRING_SLOTS; ++i)
        CHECK(force::set(&more[i], text, sizeof text, 0, &Apply::to_str) == force::Status::Ok);
    CHECK(force::set(&more[STRUCPP_FORCE_STRING_SLOTS], text, sizeof text, 0, &Apply::to_str) == force::Status::Full);
    static uint8_t huge[STRUCPP_FORCE_STRING_BYTES + 1];
    force::clear_all();
    CHECK(force::set(huge, huge, sizeof huge) == force::Status::TooLarge);
    CHECK(force::count() == 0);
`,
    );
    expect(out).toBe("OK");
  });

  it("apply_owned applies slots inside the range and GLOBAL slots, nothing else", () => {
    const out = run(
      "force_owned",
      `
    struct Prog { int32_t a; int32_t b; } p{0, 0};
    int32_t g = 0, elsewhere = 0;
    const int32_t f = 77;
    force::set(&p.b, &f, sizeof f);
    force::set(&g, &f, sizeof f, force::FLAG_GLOBAL);
    force::set(&elsewhere, &f, sizeof f);
    p.b = 0; g = 0; elsewhere = 0;
    force::apply_owned(&p, sizeof p);
    CHECK(p.b == 77);
    CHECK(g == 77);
    CHECK(elsewhere == 0);
    CHECK(p.a == 0);
`,
    );
    expect(out).toBe("OK");
  });

  it("builds and applies under STRUCPP_THREADED, where a Scope applies owned slots only", () => {
    const out = run(
      "force_threaded",
      `
    struct Prog { int32_t x; } p{0}, q{0};
    const int32_t f = 5;
    force::set(&p.x, &f, sizeof f);
    force::set(&q.x, &f, sizeof f);
    p.x = 0; q.x = 0;
    { force::Scope scope(&p, sizeof p); }
    CHECK(p.x == 5);
    CHECK(q.x == 0);
`,
      ["-DSTRUCPP_THREADED", "-pthread"],
    );
    expect(out).toBe("OK");
  });

  it("the bounds are overridable by macro", () => {
    const out = run(
      "force_macros",
      `
    static_assert(STRUCPP_FORCE_SLOTS == 3, "slots");
    static_assert(STRUCPP_FORCE_STRING_SLOTS == 2, "string slots");
    static_assert(STRUCPP_FORCE_STRING_BYTES == 20, "string bytes");
    static uint8_t v[4];
    const uint8_t one = 1;
    for (int i = 0; i < 3; ++i) CHECK(force::set(&v[i], &one, 1) == force::Status::Ok);
    CHECK(force::set(&v[3], &one, 1) == force::Status::Full);
`,
      [
        "-DSTRUCPP_FORCE_SLOTS=3",
        "-DSTRUCPP_FORCE_STRING_SLOTS=2",
        "-DSTRUCPP_FORCE_STRING_BYTES=20",
      ],
    );
    expect(out).toBe("OK");
  });
});
