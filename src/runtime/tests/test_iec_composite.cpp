// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ Runtime - Composite Type Tests
 *
 * Tests for IEC 61131-3 composite types:
 * - Arrays (1D, 2D, 3D)
 * - Structures
 * - Enumerations
 * - Subranges
 * - Pointers (REF_TO)
 *
 * Forcing goes through the force table (iec_force.hpp): a forced value is
 * written at once and again at each cycle boundary (force::apply_all here);
 * a write inside the cycle stays visible until then.
 */

#include <gtest/gtest.h>
#include <type_traits>
#include "iec_array.hpp"
#include "iec_struct.hpp"
#include "iec_enum.hpp"
#include "iec_subrange.hpp"
#include "iec_pointer.hpp"
#include "iec_force.hpp"
#include "iec_traits.hpp"
#include "iec_std_lib.hpp"

using namespace strucpp;

// =============================================================================
// Array Tests
// =============================================================================

TEST(IECArrayTest, Array1D_BasicOperations) {
    // Create array with bounds [1..5]
    using IntArray = IEC_ARRAY_1D<INT_t, ArrayBounds<1, 5>>;
    IntArray arr;
    
    // Test size and bounds
    EXPECT_EQ(arr.length(), 5);
    EXPECT_EQ(arr.lower_bound(), 1);
    EXPECT_EQ(arr.upper_bound(), 5);
    
    // Test 1-based indexing
    arr[1] = 10;
    arr[2] = 20;
    arr[3] = 30;
    arr[4] = 40;
    arr[5] = 50;
    
    EXPECT_EQ(arr[1], 10);
    EXPECT_EQ(arr[2], 20);
    EXPECT_EQ(arr[3], 30);
    EXPECT_EQ(arr[4], 40);
    EXPECT_EQ(arr[5], 50);
}

TEST(IECArrayTest, Array1D_BoundsCheckedAccess) {
    using IntArray = IEC_ARRAY_1D<INT_t, ArrayBounds<1, 3>>;
    IntArray arr;
    
    arr[1] = 100;
    arr[2] = 200;
    arr[3] = 300;
    
    // at() provides bounds-checked access
    EXPECT_EQ(arr.at(1), 100);
    EXPECT_EQ(arr.at(2), 200);
    EXPECT_EQ(arr.at(3), 300);
    
    // Out of bounds access should throw
    EXPECT_THROW(arr.at(0), std::out_of_range);
    EXPECT_THROW(arr.at(4), std::out_of_range);
}

TEST(IECArrayTest, Array1D_ElementForcing) {
    force::clear_all();
    using IntArray = IEC_ARRAY_1D<INT_t, ArrayBounds<1, 3>>;
    IntArray arr;

    arr[1] = 10;
    arr[2] = 20;

    // Force element 1 only.
    const INT_t forced = 999;
    ASSERT_EQ(force::set(&arr[1], &forced, sizeof forced), force::Status::Ok);
    EXPECT_TRUE(force::is_forced(&arr[1]));
    EXPECT_FALSE(force::is_forced(&arr[2]));
    EXPECT_EQ(arr[1], 999);

    // A write inside the cycle lands; the cycle boundary restores the force.
    arr[1] = 0;
    EXPECT_EQ(arr[1], 0);
    force::apply_all();
    EXPECT_EQ(arr[1], 999);
    EXPECT_EQ(arr[2], 20);

    // Unforce: the next write sticks across the boundary.
    EXPECT_TRUE(force::clear(&arr[1]));
    EXPECT_FALSE(force::is_forced(&arr[1]));
    arr[1] = 0;
    force::apply_all();
    EXPECT_EQ(arr[1], 0);
}

TEST(IECArrayTest, Array1D_Iteration) {
    using IntArray = IEC_ARRAY_1D<INT_t, ArrayBounds<1, 5>>;
    IntArray arr;
    
    // Initialize with values
    int val = 1;
    for (auto& elem : arr) {
        elem = val++;
    }
    
    // Verify values
    EXPECT_EQ(arr[1], 1);
    EXPECT_EQ(arr[2], 2);
    EXPECT_EQ(arr[3], 3);
    EXPECT_EQ(arr[4], 4);
    EXPECT_EQ(arr[5], 5);
}

TEST(IECArrayTest, Array1D_InitializerList) {
    using IntArray = IEC_ARRAY_1D<INT_t, ArrayBounds<1, 3>>;
    IntArray arr = {10, 20, 30};
    
    EXPECT_EQ(arr[1], 10);
    EXPECT_EQ(arr[2], 20);
    EXPECT_EQ(arr[3], 30);
}

TEST(IECArrayTest, Array1D_NegativeBounds) {
    // Test array with negative lower bound
    using IntArray = IEC_ARRAY_1D<INT_t, ArrayBounds<-2, 2>>;
    IntArray arr;
    
    EXPECT_EQ(arr.length(), 5);
    EXPECT_EQ(arr.lower_bound(), -2);
    EXPECT_EQ(arr.upper_bound(), 2);
    
    arr[-2] = -20;
    arr[-1] = -10;
    arr[0] = 0;
    arr[1] = 10;
    arr[2] = 20;
    
    EXPECT_EQ(arr[-2], -20);
    EXPECT_EQ(arr[0], 0);
    EXPECT_EQ(arr[2], 20);
}

TEST(IECArrayTest, Array2D_BasicOperations) {
    // Create 2D array [1..3, 1..4]
    using IntArray2D = IEC_ARRAY_2D<INT_t, ArrayBounds<1, 3>, ArrayBounds<1, 4>>;
    IntArray2D arr;
    
    EXPECT_EQ(arr.dim1_size(), 3);
    EXPECT_EQ(arr.dim2_size(), 4);
    EXPECT_EQ(arr.dim1_lower(), 1);
    EXPECT_EQ(arr.dim1_upper(), 3);
    EXPECT_EQ(arr.dim2_lower(), 1);
    EXPECT_EQ(arr.dim2_upper(), 4);
    
    // Set values using 2D indexing
    arr(1, 1) = 11;
    arr(1, 2) = 12;
    arr(2, 3) = 23;
    arr(3, 4) = 34;
    
    EXPECT_EQ(arr(1, 1), 11);
    EXPECT_EQ(arr(1, 2), 12);
    EXPECT_EQ(arr(2, 3), 23);
    EXPECT_EQ(arr(3, 4), 34);
}

TEST(IECArrayTest, Array2D_BoundsCheckedAccess) {
    using IntArray2D = IEC_ARRAY_2D<INT_t, ArrayBounds<1, 2>, ArrayBounds<1, 2>>;
    IntArray2D arr;
    
    arr(1, 1) = 11;
    arr(1, 2) = 12;
    arr(2, 1) = 21;
    arr(2, 2) = 22;
    
    EXPECT_EQ(arr.at(1, 1), 11);
    EXPECT_EQ(arr.at(2, 2), 22);
    
    // Out of bounds
    EXPECT_THROW(arr.at(0, 1), std::out_of_range);
    EXPECT_THROW(arr.at(1, 0), std::out_of_range);
    EXPECT_THROW(arr.at(3, 1), std::out_of_range);
    EXPECT_THROW(arr.at(1, 3), std::out_of_range);
}

TEST(IECArrayTest, Array3D_BasicOperations) {
    // Create 3D array [1..2, 1..2, 1..2]
    using IntArray3D = IEC_ARRAY_3D<INT_t, ArrayBounds<1, 2>, ArrayBounds<1, 2>, ArrayBounds<1, 2>>;
    IntArray3D arr;
    
    EXPECT_EQ(arr.dim1_size(), 2);
    EXPECT_EQ(arr.dim2_size(), 2);
    EXPECT_EQ(arr.dim3_size(), 2);
    
    arr(1, 1, 1) = 111;
    arr(1, 1, 2) = 112;
    arr(2, 2, 2) = 222;
    
    EXPECT_EQ(arr(1, 1, 1), 111);
    EXPECT_EQ(arr(1, 1, 2), 112);
    EXPECT_EQ(arr(2, 2, 2), 222);
}

TEST(IECArrayTest, ConvenienceAliases) {
    // Test convenience type aliases
    Array1D<INT_t, 1, 5> arr1d;
    EXPECT_EQ(arr1d.length(), 5);
    
    Array2D<INT_t, 1, 2, 1, 3> arr2d;
    EXPECT_EQ(arr2d.dim1_size(), 2);
    EXPECT_EQ(arr2d.dim2_size(), 3);
    
    Array3D<INT_t, 1, 2, 1, 2, 1, 2> arr3d;
    EXPECT_EQ(arr3d.dim1_size(), 2);
    EXPECT_EQ(arr3d.dim2_size(), 2);
    EXPECT_EQ(arr3d.dim3_size(), 2);
}

// =============================================================================
// Enumeration Tests
// =============================================================================

// Define a test enumeration
enum class TrafficLight : int16_t {
    RED = 0,
    YELLOW = 1,
    GREEN = 2
};

TEST(IECEnumTest, EnumValue_BasicOperations) {
    IEC_ENUM_Value<TrafficLight> light;
    
    // Default value
    EXPECT_EQ(light.get(), TrafficLight::RED);
    
    // Assignment
    light = TrafficLight::GREEN;
    EXPECT_EQ(light.get(), TrafficLight::GREEN);
    
    // Comparison
    EXPECT_TRUE(light == TrafficLight::GREEN);
    EXPECT_FALSE(light == TrafficLight::RED);
}

TEST(IECEnumTest, EnumVar_Forcing) {
    force::clear_all();
    IEC_ENUM_Var<TrafficLight> light;
    // The force table writes raw bytes: the var must be just its value.
    EXPECT_EQ(sizeof light, sizeof(TrafficLight));

    light = TrafficLight::RED;
    EXPECT_EQ(light.get().get(), TrafficLight::RED);

    // Force to GREEN
    const TrafficLight forced = TrafficLight::GREEN;
    ASSERT_EQ(force::set(&light, &forced, sizeof forced), force::Status::Ok);
    EXPECT_TRUE(force::is_forced(&light));
    EXPECT_EQ(light.get().get(), TrafficLight::GREEN);

    // A write inside the cycle lands; the cycle boundary restores the force.
    light = TrafficLight::YELLOW;
    EXPECT_EQ(light.get().get(), TrafficLight::YELLOW);
    force::apply_all();
    EXPECT_EQ(light.get().get(), TrafficLight::GREEN);

    // Unforce
    EXPECT_TRUE(force::clear(&light));
    EXPECT_FALSE(force::is_forced(&light));
    light = TrafficLight::YELLOW;
    force::apply_all();
    EXPECT_EQ(light.get().get(), TrafficLight::YELLOW);
}

TEST(IECEnumTest, EnumValue_Ordering) {
    IEC_ENUM_Value<TrafficLight> red(TrafficLight::RED);
    IEC_ENUM_Value<TrafficLight> yellow(TrafficLight::YELLOW);
    IEC_ENUM_Value<TrafficLight> green(TrafficLight::GREEN);
    
    EXPECT_TRUE(red < yellow);
    EXPECT_TRUE(yellow < green);
    EXPECT_TRUE(red <= yellow);
    EXPECT_TRUE(green > yellow);
    EXPECT_TRUE(green >= green);
}

TEST(IECEnumTest, EnumValue_ToInt) {
    IEC_ENUM_Value<TrafficLight> light(TrafficLight::YELLOW);
    EXPECT_EQ(light.to_int(), 1);
}

// =============================================================================
// Subrange Tests
// =============================================================================

TEST(IECSubrangeTest, SubrangeValue_BasicOperations) {
    // Percentage type: 0..100
    using Percentage = IEC_SUBRANGE_Value<int16_t, 0, 100>;
    
    Percentage pct;
    EXPECT_EQ(pct.get(), 0);  // Default to lower bound
    
    pct = 50;
    EXPECT_EQ(pct.get(), 50);
    
    pct = 100;
    EXPECT_EQ(pct.get(), 100);
}

TEST(IECSubrangeTest, SubrangeValue_Bounds) {
    using Percentage = IEC_SUBRANGE_Value<int16_t, 0, 100>;
    
    EXPECT_EQ(Percentage::lower_bound, 0);
    EXPECT_EQ(Percentage::upper_bound, 100);
}

TEST(IECSubrangeTest, SubrangeValue_Arithmetic) {
    using SmallInt = IEC_SUBRANGE_Value<int16_t, 1, 10>;
    
    SmallInt a(5);
    SmallInt b(3);
    
    // Arithmetic returns base type
    EXPECT_EQ(a + b, 8);
    EXPECT_EQ(a - b, 2);
    EXPECT_EQ(a * b, 15);
    EXPECT_EQ(a / b, 1);
}

TEST(IECSubrangeTest, SubrangeVar_Forcing) {
    force::clear_all();
    using Percentage = IEC_SUBRANGE_Var<int16_t, 0, 100>;

    Percentage pct;
    EXPECT_EQ(sizeof pct, sizeof(int16_t));
    pct = 50;
    EXPECT_EQ(static_cast<int16_t>(pct.get()), 50);

    // Force
    const int16_t forced = 75;
    ASSERT_EQ(force::set(&pct, &forced, sizeof forced), force::Status::Ok);
    EXPECT_TRUE(force::is_forced(&pct));
    EXPECT_EQ(static_cast<int16_t>(pct.get()), 75);

    // A write inside the cycle lands; the cycle boundary restores the force.
    pct = 25;
    EXPECT_EQ(static_cast<int16_t>(pct.get()), 25);
    force::apply_all();
    EXPECT_EQ(static_cast<int16_t>(pct.get()), 75);

    // Unforce
    EXPECT_TRUE(force::clear(&pct));
    pct = 25;
    force::apply_all();
    EXPECT_EQ(static_cast<int16_t>(pct.get()), 25);
}

TEST(IECSubrangeTest, SubrangeValue_IncrementDecrement) {
    using SmallInt = IEC_SUBRANGE_Value<int16_t, 1, 10>;
    
    SmallInt val(5);
    
    ++val;
    EXPECT_EQ(val.get(), 6);
    
    val++;
    EXPECT_EQ(val.get(), 7);
    
    --val;
    EXPECT_EQ(val.get(), 6);
    
    val--;
    EXPECT_EQ(val.get(), 5);
}

// =============================================================================
// Structure Tests
// =============================================================================

// Define a test structure (simulating generated code)
struct Point : public IEC_STRUCT_Base {
    IECVar<REAL_t> x;
    IECVar<REAL_t> y;
    
    Point() noexcept : x{}, y{} {}
    
    const char* type_name() const noexcept override { return "Point"; }
};

TEST(IECStructTest, Struct_BasicOperations) {
    Point p;
    
    p.x = 10.5f;
    p.y = 20.5f;
    
    EXPECT_FLOAT_EQ(p.x.get(), 10.5f);
    EXPECT_FLOAT_EQ(p.y.get(), 20.5f);
}

TEST(IECStructTest, Struct_TypeName) {
    Point p;
    EXPECT_STREQ(p.type_name(), "Point");
}

TEST(IECStructTest, Struct_FieldForcing) {
    force::clear_all();
    Point p;

    p.x = 10.0f;
    p.y = 20.0f;

    // Force x field
    const REAL_t forced = 100.0f;
    ASSERT_EQ(force::set(&p.x, &forced, sizeof forced), force::Status::Ok);
    EXPECT_TRUE(force::is_forced(&p.x));
    EXPECT_FLOAT_EQ(p.x.get(), 100.0f);

    // y is not affected
    EXPECT_FALSE(force::is_forced(&p.y));
    EXPECT_FLOAT_EQ(p.y.get(), 20.0f);

    // A write inside the cycle lands; the cycle boundary restores the force.
    p.x = 0.0f;
    EXPECT_FLOAT_EQ(p.x.get(), 0.0f);
    force::apply_all();
    EXPECT_FLOAT_EQ(p.x.get(), 100.0f);
    EXPECT_FLOAT_EQ(p.y.get(), 20.0f);

    // Unforce
    EXPECT_TRUE(force::clear(&p.x));
    p.x = 0.0f;
    force::apply_all();
    EXPECT_FLOAT_EQ(p.x.get(), 0.0f);
}

// Nested structure test
struct Rectangle : public IEC_STRUCT_Base {
    Point topLeft;
    Point bottomRight;
    
    Rectangle() noexcept : topLeft{}, bottomRight{} {}
    
    const char* type_name() const noexcept override { return "Rectangle"; }
};

TEST(IECStructTest, Struct_Nested) {
    Rectangle rect;
    
    rect.topLeft.x = 0.0f;
    rect.topLeft.y = 0.0f;
    rect.bottomRight.x = 100.0f;
    rect.bottomRight.y = 50.0f;
    
    EXPECT_FLOAT_EQ(rect.topLeft.x.get(), 0.0f);
    EXPECT_FLOAT_EQ(rect.bottomRight.x.get(), 100.0f);
    EXPECT_FLOAT_EQ(rect.bottomRight.y.get(), 50.0f);
}

// =============================================================================
// Type Traits Tests
// =============================================================================

TEST(IECTraitsTest, ArrayTraits) {
    using IntArray = IEC_ARRAY_1D<INT_t, ArrayBounds<1, 5>>;
    
    EXPECT_TRUE(is_iec_array_v<IntArray>);
    EXPECT_FALSE(is_iec_struct_v<IntArray>);
    EXPECT_FALSE(is_iec_enum_v<IntArray>);
    EXPECT_FALSE(is_iec_subrange_v<IntArray>);
    EXPECT_TRUE(is_any_derived_v<IntArray>);
}

TEST(IECTraitsTest, StructTraits) {
    EXPECT_TRUE(is_iec_struct_v<Point>);
    EXPECT_FALSE(is_iec_array_v<Point>);
    EXPECT_FALSE(is_iec_enum_v<Point>);
    EXPECT_TRUE(is_any_derived_v<Point>);
}

TEST(IECTraitsTest, EnumTraits) {
    using LightValue = IEC_ENUM_Value<TrafficLight>;
    using LightVar = IEC_ENUM_Var<TrafficLight>;
    
    EXPECT_TRUE(is_iec_enum_v<LightValue>);
    EXPECT_TRUE(is_iec_enum_v<LightVar>);
    EXPECT_FALSE(is_iec_array_v<LightValue>);
    EXPECT_TRUE(is_any_derived_v<LightValue>);
}

TEST(IECTraitsTest, SubrangeTraits) {
    using Percentage = IEC_SUBRANGE_Value<int16_t, 0, 100>;
    using PercentageVar = IEC_SUBRANGE_Var<int16_t, 0, 100>;
    
    EXPECT_TRUE(is_iec_subrange_v<Percentage>);
    EXPECT_TRUE(is_iec_subrange_v<PercentageVar>);
    EXPECT_FALSE(is_iec_array_v<Percentage>);
    EXPECT_TRUE(is_any_derived_v<Percentage>);
}

// =============================================================================
// New Standard Library Function Tests
// =============================================================================

TEST(IECStdLibTest, ATAN2) {
    IEC_REAL y(1.0f);
    IEC_REAL x(1.0f);
    
    auto result = ATAN2(y, x);
    // atan2(1, 1) = PI/4 ≈ 0.785
    EXPECT_NEAR(result.get(), 0.785398f, 0.0001f);
}

TEST(IECStdLibTest, TRUNC) {
    IEC_REAL pos(3.7f);
    IEC_REAL neg(-3.7f);
    
    EXPECT_FLOAT_EQ(TRUNC(pos).get(), 3.0f);
    EXPECT_FLOAT_EQ(TRUNC(neg).get(), -3.0f);
}

TEST(IECStdLibTest, ROUND) {
    IEC_REAL val1(3.4f);
    IEC_REAL val2(3.5f);
    IEC_REAL val3(3.6f);
    IEC_REAL neg(-3.5f);
    
    EXPECT_FLOAT_EQ(ROUND(val1).get(), 3.0f);
    EXPECT_FLOAT_EQ(ROUND(val2).get(), 4.0f);
    EXPECT_FLOAT_EQ(ROUND(val3).get(), 4.0f);
    EXPECT_FLOAT_EQ(ROUND(neg).get(), -4.0f);
}

TEST(IECStdLibTest, NEG) {
    IEC_INT pos(42);
    IEC_INT neg(-42);
    
    EXPECT_EQ(NEG(pos).get(), -42);
    EXPECT_EQ(NEG(neg).get(), 42);
}

TEST(IECStdLibTest, ADD_Variadic) {
    IEC_INT a(10);
    IEC_INT b(20);
    IEC_INT c(30);
    IEC_INT d(40);
    
    EXPECT_EQ(ADD(a, b).get(), 30);
    EXPECT_EQ(ADD(a, b, c).get(), 60);
    EXPECT_EQ(ADD(a, b, c, d).get(), 100);
}

TEST(IECStdLibTest, MUL_Variadic) {
    IEC_INT a(2);
    IEC_INT b(3);
    IEC_INT c(4);
    
    EXPECT_EQ(MUL(a, b).get(), 6);
    EXPECT_EQ(MUL(a, b, c).get(), 24);
}

TEST(IECStdLibTest, SUB) {
    IEC_INT a(100);
    IEC_INT b(30);
    
    EXPECT_EQ(SUB(a, b).get(), 70);
}

TEST(IECStdLibTest, DIV) {
    IEC_INT a(100);
    IEC_INT b(4);
    
    EXPECT_EQ(DIV(a, b).get(), 25);
}

TEST(IECStdLibTest, MOD) {
    IEC_INT a(17);
    IEC_INT b(5);
    
    EXPECT_EQ(MOD(a, b).get(), 2);
    
    // Test with REAL
    IEC_REAL ra(17.5f);
    IEC_REAL rb(5.0f);
    EXPECT_FLOAT_EQ(MOD(ra, rb).get(), 2.5f);
}

TEST(IECStdLibTest, NOT_Bitwise) {
    IEC_BYTE val(0x0F);
    EXPECT_EQ(NOT(val).get(), 0xF0);
}

TEST(IECStdLibTest, AND_Variadic) {
    IEC_BYTE a(0xFF);
    IEC_BYTE b(0x0F);
    IEC_BYTE c(0x03);
    
    EXPECT_EQ(AND(a, b).get(), 0x0F);
    EXPECT_EQ(AND(a, b, c).get(), 0x03);
}

TEST(IECStdLibTest, OR_Variadic) {
    IEC_BYTE a(0x01);
    IEC_BYTE b(0x02);
    IEC_BYTE c(0x04);
    
    EXPECT_EQ(OR(a, b).get(), 0x03);
    EXPECT_EQ(OR(a, b, c).get(), 0x07);
}

TEST(IECStdLibTest, XOR_Variadic) {
    IEC_BYTE a(0xFF);
    IEC_BYTE b(0x0F);
    IEC_BYTE c(0x03);
    
    EXPECT_EQ(XOR(a, b).get(), 0xF0);
    EXPECT_EQ(XOR(a, b, c).get(), 0xF3);
}

TEST(IECStdLibTest, MAX_Variadic) {
    IEC_INT a(10);
    IEC_INT b(50);
    IEC_INT c(30);
    IEC_INT d(20);
    
    EXPECT_EQ(MAX(a, b, c, d).get(), 50);
}

TEST(IECStdLibTest, MIN_Variadic) {
    IEC_INT a(10);
    IEC_INT b(50);
    IEC_INT c(30);
    IEC_INT d(5);
    
    EXPECT_EQ(MIN(a, b, c, d).get(), 5);
}

TEST(IECStdLibTest, MUX_Variadic) {
    IEC_INT a(100);
    IEC_INT b(200);
    IEC_INT c(300);

    // Strucpp uses a single `MUX` template that handles K + any
    // number of inputs ≥2 — formerly split between `MUX(k, in0,
    // in1)` and a separate `MUX_V` for 3+.  Verify the unified
    // path still selects correctly across the chain.
    EXPECT_EQ(MUX(IEC_INT(0), a, b, c).get(), 100);
    EXPECT_EQ(MUX(IEC_INT(1), a, b, c).get(), 200);
    EXPECT_EQ(MUX(IEC_INT(2), a, b, c).get(), 300);

    IEC_INT d(400);
    IEC_INT e(500);
    EXPECT_EQ(MUX(IEC_INT(3), a, b, c, d, e).get(), 400);
    EXPECT_EQ(MUX(IEC_INT(4), a, b, c, d, e).get(), 500);
}

TEST(IECStdLibTest, MOVE) {
    IEC_INT val(42);
    EXPECT_EQ(MOVE(val).get(), 42);
}

// Variadic-chain comparisons formerly lived under `*_CHAIN` names.
// Strucpp now exposes them as additional overloads of the canonical
// IEC names (GT, GE, EQ, LE, LT, NE) so the generated C++ can call
// e.g. `GT(a, b, c)` directly.

TEST(IECStdLibTest, GT_Variadic) {
    IEC_INT a(30);
    IEC_INT b(20);
    IEC_INT c(10);
    IEC_INT d(5);

    EXPECT_TRUE(GT(a, b).get());
    EXPECT_TRUE(GT(a, b, c).get());
    EXPECT_TRUE(GT(a, b, c, d).get());

    // Not strictly decreasing
    IEC_INT e(10);
    EXPECT_FALSE(GT(a, b, c, e).get());  // c == e
}

TEST(IECStdLibTest, GE_Variadic) {
    IEC_INT a(30);
    IEC_INT b(20);
    IEC_INT c(20);
    IEC_INT d(10);

    EXPECT_TRUE(GE(a, b).get());
    EXPECT_TRUE(GE(a, b, c).get());  // b == c is OK
    EXPECT_TRUE(GE(a, b, c, d).get());

    // Increasing
    EXPECT_FALSE(GE(d, c, b, a).get());
}

TEST(IECStdLibTest, EQ_Variadic) {
    IEC_INT a(10);
    IEC_INT b(10);
    IEC_INT c(10);

    EXPECT_TRUE(EQ(a, b).get());
    EXPECT_TRUE(EQ(a, b, c).get());

    IEC_INT d(20);
    EXPECT_FALSE(EQ(a, b, d).get());
}

TEST(IECStdLibTest, LE_Variadic) {
    IEC_INT a(10);
    IEC_INT b(20);
    IEC_INT c(20);
    IEC_INT d(30);

    EXPECT_TRUE(LE(a, b).get());
    EXPECT_TRUE(LE(a, b, c).get());  // b == c is OK
    EXPECT_TRUE(LE(a, b, c, d).get());

    // Decreasing
    EXPECT_FALSE(LE(d, c, b, a).get());
}

TEST(IECStdLibTest, LT_Variadic) {
    IEC_INT a(10);
    IEC_INT b(20);
    IEC_INT c(30);
    IEC_INT d(40);

    EXPECT_TRUE(LT(a, b).get());
    EXPECT_TRUE(LT(a, b, c).get());
    EXPECT_TRUE(LT(a, b, c, d).get());

    // Not strictly increasing
    IEC_INT e(30);
    EXPECT_FALSE(LT(a, b, c, e).get());  // c == e
}

TEST(IECStdLibTest, NE_Variadic) {
    IEC_INT a(10);
    IEC_INT b(20);
    IEC_INT c(30);

    EXPECT_TRUE(NE(a, b).get());
    EXPECT_TRUE(NE(a, b, c).get());

    // Any adjacent equal pair breaks the chain
    IEC_INT d(20);
    EXPECT_FALSE(NE(a, b, d).get());  // b == d
}


// =============================================================================
// Pointer (REF_TO) Tests
// =============================================================================

TEST(IECPointerTest, Pointer_DefaultNull) {
    REF_TO<INT_t> ptr;
    
    EXPECT_TRUE(ptr.is_null());
    EXPECT_TRUE(ptr == IEC_NULL);
    EXPECT_FALSE(ptr != IEC_NULL);
    EXPECT_FALSE(static_cast<bool>(ptr));
}

TEST(IECPointerTest, Pointer_REF_Operator) {
    IEC_INT var(42);
    REF_TO<INT_t> ptr = REF(var);
    
    EXPECT_FALSE(ptr.is_null());
    EXPECT_TRUE(ptr != IEC_NULL);
    EXPECT_TRUE(static_cast<bool>(ptr));
    EXPECT_EQ(ptr.deref().get(), 42);
}

TEST(IECPointerTest, Pointer_Dereference_Read) {
    IEC_INT V1, V2;
    V2 = 100;
    
    REF_TO<INT_t> rV = REF(V2);
    
    // Read V2 via reference
    V1 = rV.deref().get();
    EXPECT_EQ(V1.get(), 100);
}

TEST(IECPointerTest, Pointer_Dereference_Write) {
    IEC_INT V2;
    V2 = 0;
    
    REF_TO<INT_t> rV = REF(V2);
    
    // Assign 12 to V2 via reference (rV^ := 12)
    rV.deref() = 12;
    EXPECT_EQ(V2.get(), 12);
}

TEST(IECPointerTest, Pointer_NullCheck) {
    IEC_INT target(42);
    REF_TO<INT_t> rV;
    
    // Initially NULL
    EXPECT_TRUE(rV == IEC_NULL);
    
    // Assign address
    rV = REF(target);
    EXPECT_TRUE(rV != IEC_NULL);
    
    // Reset to NULL
    rV = IEC_NULL;
    EXPECT_TRUE(rV == IEC_NULL);
}

TEST(IECPointerTest, Pointer_ConditionalDereference) {
    IEC_INT target(0);
    REF_TO<INT_t> rV;
    
    // Simulate: IF rV <> NULL THEN rV^ := 42; END_IF;
    if (rV != IEC_NULL) {
        rV.deref() = 42;
    }
    EXPECT_EQ(target.get(), 0);  // Not modified because rV was NULL
    
    // Now assign address and try again
    rV = REF(target);
    if (rV != IEC_NULL) {
        rV.deref() = 42;
    }
    EXPECT_EQ(target.get(), 42);  // Modified because rV was not NULL
}

TEST(IECPointerTest, Pointer_Reassignment) {
    IEC_INT target1(100);
    IEC_INT target2(200);
    REF_TO<INT_t> ptr;
    
    ptr = REF(target1);
    EXPECT_EQ(ptr.deref().get(), 100);
    
    ptr = REF(target2);
    EXPECT_EQ(ptr.deref().get(), 200);
}

TEST(IECPointerTest, Pointer_Forcing) {
    force::clear_all();
    IEC_INT target1(100);
    IEC_INT target2(200);
    REF_TO<INT_t> ptr = REF(target1);
    // The force table writes raw bytes: REF_TO must be just the address.
    IEC_INT* const forced = &target2;
    ASSERT_EQ(sizeof ptr, sizeof forced);

    EXPECT_EQ(ptr.deref().get(), 100);
    EXPECT_FALSE(force::is_forced(&ptr));

    // Force pointer to point to target2
    ASSERT_EQ(force::set(&ptr, &forced, sizeof forced), force::Status::Ok);
    EXPECT_TRUE(force::is_forced(&ptr));
    EXPECT_EQ(ptr.deref().get(), 200);

    // A write inside the cycle lands; the cycle boundary restores the force.
    ptr = REF(target1);
    EXPECT_EQ(ptr.deref().get(), 100);
    force::apply_all();
    EXPECT_EQ(ptr.deref().get(), 200);

    // Unforce
    EXPECT_TRUE(force::clear(&ptr));
    EXPECT_FALSE(force::is_forced(&ptr));
    ptr = REF(target1);
    force::apply_all();
    EXPECT_EQ(ptr.deref().get(), 100);
}

TEST(IECPointerTest, Pointer_ForceToNull) {
    force::clear_all();
    IEC_INT target(42);
    REF_TO<INT_t> ptr = REF(target);

    EXPECT_FALSE(ptr.is_null());

    // Force to NULL
    IEC_INT* const forced = nullptr;
    ASSERT_EQ(force::set(&ptr, &forced, sizeof forced), force::Status::Ok);
    EXPECT_TRUE(force::is_forced(&ptr));
    EXPECT_TRUE(ptr.is_null());

    // Unforce, then rebind as the program would
    EXPECT_TRUE(force::clear(&ptr));
    ptr = REF(target);
    force::apply_all();
    EXPECT_FALSE(ptr.is_null());
    EXPECT_EQ(ptr.deref().get(), 42);
}

TEST(IECPointerTest, Pointer_Comparison) {
    IEC_INT target1(100);
    IEC_INT target2(200);
    
    REF_TO<INT_t> ptr1 = REF(target1);
    REF_TO<INT_t> ptr2 = REF(target1);
    REF_TO<INT_t> ptr3 = REF(target2);
    
    EXPECT_TRUE(ptr1 == ptr2);   // Both point to target1
    EXPECT_FALSE(ptr1 == ptr3);  // Different targets
    EXPECT_TRUE(ptr1 != ptr3);
}

TEST(IECPointerTest, Pointer_ArrowOperator) {
    IEC_INT target(42);
    REF_TO<INT_t> ptr = REF(target);

    // Use arrow operator to access IECVar methods
    EXPECT_EQ(ptr->get(), 42);
    ptr->set(7);
    EXPECT_EQ(target.get(), 7);

    // The const overload hands out a pointer to a const target.
    const REF_TO<INT_t>& cptr = ptr;
    static_assert(std::is_same<decltype(cptr.operator->()), const IEC_INT*>::value,
                  "const REF_TO::operator-> must return a pointer to const");
    EXPECT_EQ(cptr->get(), 7);
}

TEST(IECPointerTest, Pointer_StarOperator) {
    IEC_INT target(42);
    REF_TO<INT_t> ptr = REF(target);
    
    // Use * operator (same as deref())
    EXPECT_EQ((*ptr).get(), 42);
    
    (*ptr) = 100;
    EXPECT_EQ(target.get(), 100);
}

TEST(IECPointerTest, Pointer_ForcedValueReadBack) {
    force::clear_all();
    IEC_INT target1(100);
    IEC_INT target2(200);
    REF_TO<INT_t> ptr = REF(target1);

    // Force to target2
    IEC_INT* const forced = &target2;
    ASSERT_EQ(force::set(&ptr, &forced, sizeof forced), force::Status::Ok);

    // get() returns the forced pointer
    EXPECT_EQ(ptr.get(), &target2);

    // The table holds the forced value; there is no per-variable copy.
    IEC_INT* stored = nullptr;
    EXPECT_EQ(force::read(&ptr, &stored, sizeof stored), sizeof stored);
    EXPECT_EQ(stored, &target2);
    EXPECT_TRUE(force::clear(&ptr));
}

// =============================================================================
// Pointer Type Traits Tests
// =============================================================================

TEST(IECTraitsTest, PointerTraits) {
    using IntPtr = REF_TO<INT_t>;
    
    EXPECT_TRUE(is_iec_pointer_v<IntPtr>);
    EXPECT_FALSE(is_iec_array_v<IntPtr>);
    EXPECT_FALSE(is_iec_struct_v<IntPtr>);
    EXPECT_FALSE(is_iec_enum_v<IntPtr>);
    EXPECT_TRUE(is_any_derived_v<IntPtr>);
}
