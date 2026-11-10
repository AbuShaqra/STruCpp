// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2026 Autonomy®
/**
 * STruC++ Runtime - Force Table Unit Tests
 *
 * The force table holds forced values beside their variables and writes them
 * in at once and at both cycle boundaries (force::Scope).
 */

#include <gtest/gtest.h>
#include <cstring>
#include "iec_force.hpp"

namespace force = strucpp::force;

namespace {

class ForceTableTest : public ::testing::Test {
protected:
    void SetUp() override { force::clear_all(); }
    void TearDown() override { force::clear_all(); }
};

}  // namespace

TEST_F(ForceTableTest, SetWritesAtOnceAndMarksForced) {
    int32_t v = 1;
    const int32_t f = 42;
    EXPECT_EQ(force::set(&v, &f, sizeof f), force::Status::Ok);
    EXPECT_EQ(v, 42);
    EXPECT_TRUE(force::is_forced(&v));
    EXPECT_EQ(force::count(), 1u);
}

TEST_F(ForceTableTest, ReForceReplacesTheValue) {
    int16_t v = 0;
    const int16_t a = 1, b = 2;
    force::set(&v, &a, sizeof a);
    force::set(&v, &b, sizeof b);
    EXPECT_EQ(force::count(), 1u);
    v = 9;
    force::apply_all();
    EXPECT_EQ(v, 2);
}

TEST_F(ForceTableTest, ClearKeepsTheValueAndStopsApplying) {
    uint8_t v = 0;
    const uint8_t f = 5;
    force::set(&v, &f, 1);
    EXPECT_TRUE(force::clear(&v));
    EXPECT_FALSE(force::is_forced(&v));
    EXPECT_EQ(v, 5);
    v = 3;
    force::apply_all();
    EXPECT_EQ(v, 3);
    EXPECT_FALSE(force::clear(&v));
}

TEST_F(ForceTableTest, RefusesPastTheBound) {
    static uint8_t vars[STRUCPP_FORCE_SLOTS + 1];
    const uint8_t one = 1;
    for (int i = 0; i < STRUCPP_FORCE_SLOTS; ++i) {
        ASSERT_EQ(force::set(&vars[i], &one, 1), force::Status::Ok);
    }
    EXPECT_EQ(force::set(&vars[STRUCPP_FORCE_SLOTS], &one, 1), force::Status::Full);
    EXPECT_EQ(vars[STRUCPP_FORCE_SLOTS], 0);
}

TEST_F(ForceTableTest, RefusesTooLargeAndEmptyValues) {
    static uint8_t huge[STRUCPP_FORCE_STRING_BYTES + 1];
    EXPECT_EQ(force::set(huge, huge, sizeof huge), force::Status::TooLarge);
    EXPECT_EQ(force::set(nullptr, huge, 1), force::Status::BadArgument);
    EXPECT_EQ(force::set(huge, huge, 0), force::Status::BadArgument);
    EXPECT_EQ(force::count(), 0u);
}

TEST_F(ForceTableTest, ReadAndValuePtrServeTheForcedValue) {
    int32_t v = 0;
    const int32_t f = 7;
    force::set(&v, &f, sizeof f);
    v = 100;
    int32_t seen = 0;
    EXPECT_EQ(force::read(&v, &seen, sizeof seen), sizeof seen);
    EXPECT_EQ(seen, 7);
    uint16_t n = 0;
    const void* p = force::value_ptr(&v, &n);
    ASSERT_NE(p, nullptr);
    EXPECT_EQ(n, sizeof f);
    EXPECT_EQ(std::memcmp(p, &f, sizeof f), 0);
}

TEST_F(ForceTableTest, ScopeAppliesAtStartAndEnd) {
    struct Prog {
        int32_t x = 0;
        int32_t seen = 0;
        void run() {
            force::Scope scope(this, sizeof(*this));
            seen = x;
            x = 5;
        }
    } p;
    const int32_t f = 100;
    force::set(&p.x, &f, sizeof f);
    p.x = 1;
    p.run();
    EXPECT_EQ(p.seen, 100);
    EXPECT_EQ(p.x, 100);
}

TEST_F(ForceTableTest, ApplyOwnedTakesTheRangeAndGlobals) {
    struct Prog { int32_t a; int32_t b; } p{0, 0};
    int32_t g = 0, other = 0;
    const int32_t f = 77;
    force::set(&p.b, &f, sizeof f);
    force::set(&g, &f, sizeof f, force::FLAG_GLOBAL);
    force::set(&other, &f, sizeof f);
    p.b = g = other = 0;
    force::apply_owned(&p, sizeof p);
    EXPECT_EQ(p.b, 77);
    EXPECT_EQ(g, 77);
    EXPECT_EQ(other, 0);
}

TEST_F(ForceTableTest, StringSlotUsesItsApplyFunction) {
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
    EXPECT_EQ(force::set(&s, text, sizeof text, 0, &Apply::to_str), force::Status::Ok);
    std::strcpy(s.data, "x");
    s.len = 1;
    force::apply_all();
    EXPECT_STREQ(s.data, "forced string");
    EXPECT_EQ(s.len, 13);
}
