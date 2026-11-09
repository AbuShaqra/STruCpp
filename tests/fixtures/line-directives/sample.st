FUNCTION AddOne : INT
  VAR_INPUT a : INT; END_VAR
  AddOne := a + 1;
END_FUNCTION

FUNCTION_BLOCK FB_X
  VAR_INPUT step : INT := 2; END_VAR
  VAR count : INT; END_VAR
  METHOD Bump : INT
    count := count + step;
    Bump := count;
  END_METHOD
  count := AddOne(count);
END_FUNCTION_BLOCK

PROGRAM Main
  VAR
    x : INT;
    fb : FB_X;
  END_VAR
  fb();
  x := fb.Bump();
END_PROGRAM

CONFIGURATION Cfg
  RESOURCE Res ON PLC
    TASK T(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM Inst WITH T : Main;
  END_RESOURCE
END_CONFIGURATION
