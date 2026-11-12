TEST 'LTON fires at PT and reports LTIME ET'
  VAR t : LTON; END_VAR
  t(IN := TRUE, PT := LTIME#100ms);
  ADVANCE_TIME(T#60ms);
  t(IN := TRUE, PT := LTIME#100ms);
  ASSERT_FALSE(t.Q);
  ASSERT_EQ(t.ET, LTIME#60ms);
  ADVANCE_TIME(T#40ms);
  t(IN := TRUE, PT := LTIME#100ms);
  ASSERT_TRUE(t.Q);
  ASSERT_EQ(t.ET, LTIME#100ms);
  t(IN := FALSE, PT := LTIME#100ms);
  ASSERT_FALSE(t.Q);
  ASSERT_EQ(t.ET, LTIME#0s);
END_TEST

TEST 'LTOF holds Q for PT after IN falls'
  VAR t : LTOF; END_VAR
  t(IN := TRUE, PT := LT#50ms);
  ASSERT_TRUE(t.Q);
  t(IN := FALSE, PT := LT#50ms);
  ADVANCE_TIME(T#30ms);
  t(IN := FALSE, PT := LT#50ms);
  ASSERT_TRUE(t.Q);
  ADVANCE_TIME(T#20ms);
  t(IN := FALSE, PT := LT#50ms);
  ASSERT_FALSE(t.Q);
END_TEST

TEST 'LTP pulses for PT'
  VAR t : LTP; END_VAR
  t(IN := TRUE, PT := LTIME#1s);
  ASSERT_TRUE(t.Q);
  ADVANCE_TIME(T#999ms);
  t(IN := FALSE, PT := LTIME#1s);
  ASSERT_TRUE(t.Q);
  ADVANCE_TIME(T#1ms);
  t(IN := FALSE, PT := LTIME#1s);
  ASSERT_FALSE(t.Q);
END_TEST
