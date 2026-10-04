import "./requireRealServerE2EEnv.mjs";

if (process.env.SLIVER_GUI_M1_REAL_E2E !== "1") {
  throw new Error("SLIVER_GUI_M1_REAL_E2E=1 is required for the packaged M1 real-server test");
}

console.log("M1 real-server packaged E2E opt-in validated; the test must run rather than skip");
