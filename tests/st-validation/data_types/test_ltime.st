TEST 'LTIME literals in every unit'
  VAR a : LTIME; END_VAR
  a := LTIME#1d2h3m4s5ms6us7ns;
  ASSERT_EQ(LTIME_TO_LINT(a), LINT#93784005006007);
  a := LT#-1_500ms;
  ASSERT_EQ(LTIME_TO_LINT(a), LINT#-1500000000);
  a := LTIME#100000d;
  ASSERT_EQ(LTIME_TO_LINT(a), LINT#8640000000000000000);
END_TEST

TEST 'LTIME arithmetic, comparison and TIME mixing'
  VAR a : LTIME := LTIME#2s; t : TIME := T#500ms; r : LTIME; END_VAR
  r := a + t;
  ASSERT_EQ(r, LTIME#2s500ms);
  r := a - t;
  ASSERT_EQ(r, LTIME#1s500ms);
  r := a * 3;
  ASSERT_EQ(r, LTIME#6s);
  r := a / 4;
  ASSERT_EQ(r, LTIME#500ms);
  ASSERT_TRUE(a > t);
  ASSERT_TRUE(t <= a);
  r := t;
  ASSERT_EQ(r, LTIME#500ms);
  ASSERT_EQ(LTimeSum(a, t), LTIME#2s500ms);
END_TEST

TEST 'LTIME conversions'
  VAR a : LTIME := LTIME#1s; t : TIME; s : STRING; END_VAR
  t := LTIME_TO_TIME(a);
  ASSERT_EQ(t, T#1s);
  a := TIME_TO_LTIME(T#250ms);
  ASSERT_EQ(a, LTIME#250ms);
  a := TO_LTIME(T#3s);
  ASSERT_EQ(a, LTIME#3s);
  ASSERT_EQ(LTIME_TO_LINT(LTIME#1us), LINT#1000);
  a := LINT_TO_LTIME(LINT#42);
  ASSERT_EQ(a, LTIME#42ns);
END_TEST
