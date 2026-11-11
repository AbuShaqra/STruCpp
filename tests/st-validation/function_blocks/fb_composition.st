FUNCTION_BLOCK Sensor
  VAR_OUTPUT value : INT; END_VAR
  value := 42;
END_FUNCTION_BLOCK

FUNCTION_BLOCK Controller
  VAR PUBLIC
    sensor : Sensor;
  END_VAR
  VAR_OUTPUT
    reading : INT;
    processed : BOOL;
  END_VAR
  sensor();
  reading := sensor.value;
  processed := TRUE;
END_FUNCTION_BLOCK
