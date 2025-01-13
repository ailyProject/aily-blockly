Arduino.forBlock["procedures_defreturn"] = function (block) {
  // Define a procedure with a return value.
  const funcName = Arduino.getProcedureName(block.getFieldValue("NAME"));
  let xfix1 = "";
  if (Arduino.STATEMENT_PREFIX) {
    xfix1 += Arduino.injectId(Arduino.STATEMENT_PREFIX, block);
  }
  if (Arduino.STATEMENT_SUFFIX) {
    xfix1 += Arduino.injectId(Arduino.STATEMENT_SUFFIX, block);
  }
  if (xfix1) {
    xfix1 = Arduino.prefixLines(xfix1, Arduino.INDENT);
  }
  let loopTrap = "";
  if (Arduino.INFINITE_LOOP_TRAP) {
    loopTrap = Arduino.prefixLines(
      Arduino.injectId(Arduino.INFINITE_LOOP_TRAP, block),
      Arduino.INDENT,
    );
  }
  let branch = "";
  if (block.getInput("STACK")) {
    // The 'procedures_defreturn' block might not have a STACK input.
    branch = Arduino.statementToCode(block, "STACK");
  }
  let returnValue = "";
  if (block.getInput("RETURN")) {
    // The 'procedures_defnoreturn' block (which shares this code)
    // does not have a RETURN input.
    returnValue =
      Arduino.valueToCode(block, "RETURN", Arduino.ORDER_NONE) || "";
  }
  let xfix2 = "";
  if (branch && returnValue) {
    // After executing the function body, revisit this block for the return.
    xfix2 = xfix1;
  }
  if (returnValue) {
    returnValue = Arduino.INDENT + "return " + returnValue + ";\n";
  }
  const args = [];
  const variables = block.getVars();
  for (let i = 0; i < variables.length; i++) {
    args[i] = Arduino.getVariableName(variables[i]);
  }
  let code =
    "function " +
    funcName +
    "(" +
    args.join(", ") +
    ") {\n" +
    xfix1 +
    loopTrap +
    branch +
    xfix2 +
    returnValue +
    "}";
  code = Arduino.scrub_(block, code);
  // Add % so as not to collide with helper functions in definitions list.
  // TODO(#7600): find better approach than casting to any to override
  // CodeGenerator declaring .definitions protected.
  Arduino.definitions_["%" + funcName] = code;
  Arduino.addFunction(funcName, code);
  return null;
};

// Defining a procedure without a return value uses the same generator as
// a procedure with a return value.
// export const procedures_defnoreturn = procedures_defreturn;
Arduino.forBlock["procedures_defnoreturn"] =
  Arduino.forBlock["procedures_defreturn"];

Arduino.forBlock["procedures_callreturn"] = function (block) {
  // Call a procedure with a return value.
  const funcName = Arduino.getProcedureName(block.getFieldValue("NAME"));
  const args = [];
  const variables = block.getVars();
  for (let i = 0; i < variables.length; i++) {
    args[i] =
      Arduino.valueToCode(block, "ARG" + i, Arduino.ORDER_NONE) || "null";
  }
  const code = funcName + "(" + args.join(", ") + ")";
  return [code, Arduino.ORDER_FUNCTION_CALL];
};

Arduino.forBlock["procedures_callnoreturn"] = function (block) {
  // Call a procedure with no return value.
  // Generated code is for a function call as a statement is the same as a
  // function call as a value, with the addition of line ending.
  const tuple = Arduino.forBlock["procedures_callreturn"](block, Arduino);
  return tuple[0] + ";\n";
};

Arduino.forBlock["procedures_ifreturn"] = function (block) {
  // Conditionally return value from a procedure.
  const condition =
    Arduino.valueToCode(block, "CONDITION", Arduino.ORDER_NONE) || "false";
  let code = "if (" + condition + ") {\n";
  if (Arduino.STATEMENT_SUFFIX) {
    // Inject any statement suffix here since the regular one at the end
    // will not get executed if the return is triggered.
    code += Arduino.prefixLines(
      Arduino.injectId(Arduino.STATEMENT_SUFFIX, block),
      Arduino.INDENT,
    );
  }
  if (block.hasReturnValue_) {
    const value =
      Arduino.valueToCode(block, "VALUE", Arduino.ORDER_NONE) || "null";
    code += Arduino.INDENT + "return " + value + ";\n";
  } else {
    code += Arduino.INDENT + "return;\n";
  }
  code += "}\n";
  return code;
};
