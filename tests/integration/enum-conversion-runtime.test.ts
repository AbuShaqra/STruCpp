// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Runtime: the conversion functions take an enumeration variable, value or
 * C++ enum and convert its underlying integer. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("enum conversion in the runtime", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-enumconv-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("converts the underlying integer", () => {
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: "",
      cppCode: "",
      testName: "enum_conversion_runtime",
      mainCode: `
namespace strucpp {
enum class E_MODE { ALPHA, BETA = 5, GAMMA };
enum class E_W : uint16_t { W1 = 1, W2 = 300 };
}
int main() {
    using namespace strucpp;
    IEC_ENUM_Var<E_MODE> m(E_MODE::GAMMA);
    IEC_ENUM_Value<E_MODE> v(E_MODE::BETA);
    IEC_ENUM_Var<E_W> w(E_W::W2);
    std::cout << TO_DINT(m).get() << " " << TO_INT(v).get() << " "
              << TO_UDINT(w).get() << " " << TO_LINT(E_MODE::GAMMA).get() << " "
              << TO_REAL(m).get() << " " << int(TO_BYTE(m).get()) << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("6 5 300 6 6 6");
  });
});
