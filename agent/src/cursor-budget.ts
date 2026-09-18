import { AppError, limits } from "@kiteline/shared/protocol";

export class CursorBudget {
  private count = 0;
  reserve() {
    if (this.count >= limits.cursorsPerDevice)
      throw new AppError("busy", "列表读取过多，请稍后重试");
    this.count++;
    let released = false;
    return () => {
      if (!released) this.count--;
      released = true;
    };
  }
}
