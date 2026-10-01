import { agentLimits } from "./limits.js";
import { AppError } from "@kiteline/shared/protocol";

export class CursorBudget {
  private count = 0;
  reserve() {
    if (this.count >= agentLimits.cursorsPerDevice)
      throw new AppError("busy", "Too many active list reads; try again later");
    this.count++;
    let released = false;
    return () => {
      if (!released) this.count--;
      released = true;
    };
  }
}
