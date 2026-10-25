import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Display, InputEvent } from "@ios-sim/protocol";

const execFileAsync = promisify(execFile);

export class InputUnavailableError extends Error {
  constructor(message = "Touch/keyboard input requires idb on the host.") {
    super(message);
    this.name = "InputUnavailableError";
  }
}

export class InputCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "InputCommandError";
  }
}

/**
 * Thin wrapper around `idb ui`. Indigo HID is private Apple SPI; idb is the
 * maintained, supported-by-the-community path and handles Xcode changes
 * (including the Xcode 27 DTUHID switch) for us.
 */
export class IdbInput {
  private available: boolean | undefined;

  constructor(private readonly executable = process.env.IOS_SIM_IDB ?? "idb") {}

  async isAvailable(): Promise<boolean> {
    if (this.available !== undefined) return this.available;
    try {
      await execFileAsync(this.executable, ["--help"], { timeout: 15_000 });
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  private async run(args: string[]): Promise<void> {
    if (!(await this.isAvailable())) throw new InputUnavailableError();
    try {
      await execFileAsync(this.executable, args, {
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      const detail = error as { stderr?: string; message?: string };
      throw new InputCommandError(
        detail.message ?? `idb ${args.join(" ")} failed`,
        detail.stderr ?? "",
      );
    }
  }

  async send(udid: string, event: InputEvent, display: Display): Promise<void> {
    const x = (value: number) => Math.round(value * display.widthPoints);
    const y = (value: number) => Math.round(value * display.heightPoints);

    switch (event.type) {
      case "tap":
        await this.run(["ui", "tap", String(x(event.x)), String(y(event.y)), "--udid", udid]);
        return;
      case "swipe":
        await this.run([
          "ui",
          "swipe",
          String(x(event.from.x)),
          String(y(event.from.y)),
          String(x(event.to.x)),
          String(y(event.to.y)),
          "--duration",
          String(event.durationMs / 1000),
          "--udid",
          udid,
        ]);
        return;
      case "text":
        await this.run(["ui", "text", event.text, "--udid", udid]);
        return;
      case "key":
        await this.run(["ui", "key", event.key, "--udid", udid]);
        return;
      case "button": {
        const button = {
          home: "HOME",
          lock: "LOCK",
          siri: "SIRI",
          side: "SIDE_BUTTON",
        }[event.button];
        await this.run(["ui", "button", button, "--udid", udid]);
        return;
      }
    }
  }
}
