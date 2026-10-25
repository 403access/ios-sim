import { describe, expect, it } from "vitest";
import { compareVersions, parseDevices, parsePid, runtimeLabel } from "./simctl.js";

const runtimes = [
  {
    identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
    name: "iOS 26.4",
    version: "26.4",
    platform: "iOS",
    isAvailable: true,
  },
];

describe("runtimeLabel", () => {
  it("formats a runtime identifier", () => {
    expect(runtimeLabel("com.apple.CoreSimulator.SimRuntime.iOS-26-4")).toBe("iOS 26.4");
    expect(runtimeLabel("com.apple.CoreSimulator.SimRuntime.iOS-18-4")).toBe("iOS 18.4");
  });

  it("falls back to the raw identifier", () => {
    expect(runtimeLabel("custom-runtime")).toBe("custom runtime");
  });
});

describe("parseDevices", () => {
  it("maps runtime names, filters nothing, and sorts", () => {
    const devices = parseDevices(
      {
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
            {
              udid: "B",
              name: "iPhone B",
              state: "Booted",
              isAvailable: true,
              deviceTypeIdentifier: "phone",
            },
            {
              udid: "A",
              name: "iPhone A",
              state: "Shutdown",
              isAvailable: false,
              deviceTypeIdentifier: "phone",
            },
          ],
        },
      },
      runtimes,
    );

    expect(devices.map((device) => device.name)).toEqual(["iPhone A", "iPhone B"]);
    expect(devices[0]).toMatchObject({
      runtime: "iOS 26.4",
      state: "Shutdown",
      isAvailable: false,
    });
  });

  it("derives a label when runtimes are unavailable", () => {
    const devices = parseDevices(
      {
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
            {
              udid: "A",
              name: "iPhone A",
              state: "Booted",
              isAvailable: true,
              deviceTypeIdentifier: "phone",
            },
          ],
        },
      },
      [],
    );
    expect(devices[0]?.runtime).toBe("iOS 18.5");
  });
});

describe("parsePid", () => {
  it("parses simctl launch output", () => {
    expect(parsePid("com.example.app: 4242\n")).toBe(4242);
    expect(parsePid("com.example.app: 4242")).toBe(4242);
  });

  it("rejects output without a pid", () => {
    expect(() => parsePid("something went wrong")).toThrow(/Could not parse pid/);
  });
});

describe("compareVersions", () => {
  it("compares numeric components", () => {
    expect(compareVersions("26.4", "26.3")).toBeGreaterThan(0);
    expect(compareVersions("26.4.1", "26.4")).toBeGreaterThan(0);
    expect(compareVersions("18.4", "26.4")).toBeLessThan(0);
    expect(compareVersions("26.4", "26.4")).toBe(0);
  });
});
