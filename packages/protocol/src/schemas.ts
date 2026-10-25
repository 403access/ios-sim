import { z } from "zod";

/**
 * States reported by `simctl`. Apple occasionally adds states, so unknown
 * values are passed through instead of breaking the whole device list.
 */
export const deviceStateSchema = z.string().min(1);

export const deviceSchema = z.object({
  udid: z.string().min(1),
  name: z.string().min(1),
  runtime: z.string().min(1),
  runtimeIdentifier: z.string().min(1),
  deviceTypeIdentifier: z.string().min(1),
  state: deviceStateSchema,
  isAvailable: z.boolean(),
});
export type Device = z.infer<typeof deviceSchema>;

export const runtimeSchema = z.object({
  identifier: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  platform: z.string().min(1),
  isAvailable: z.boolean(),
});
export type SimRuntime = z.infer<typeof runtimeSchema>;

export const displaySchema = z.object({
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  scale: z.number().positive(),
  widthPoints: z.number().positive(),
  heightPoints: z.number().positive(),
  format: z.enum(["jpeg", "png"]),
});
export type Display = z.infer<typeof displaySchema>;

export const appSchema = z.object({
  bundleIdentifier: z.string().min(1),
  name: z.string().min(1),
  path: z.string().optional(),
  version: z.string().optional(),
  build: z.string().optional(),
});
export type AppInfo = z.infer<typeof appSchema>;

export const healthSchema = z.object({
  ok: z.boolean(),
  service: z.literal("ios-sim-host"),
  version: z.string(),
  platform: z.string(),
  backend: z.string(),
  hostname: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  capabilities: z.object({
    input: z.boolean(),
    install: z.boolean(),
    logs: z.boolean(),
    streaming: z.boolean(),
  }),
  xcode: z.string().optional(),
});
export type Health = z.infer<typeof healthSchema>;

export const deviceListSchema = z.object({
  devices: z.array(deviceSchema),
});
export type DeviceList = z.infer<typeof deviceListSchema>;

export const appListSchema = z.object({
  apps: z.array(appSchema),
});
export type AppList = z.infer<typeof appListSchema>;

export const createDeviceRequestSchema = z.object({
  name: z.string().min(1),
  deviceTypeIdentifier: z.string().min(1).optional(),
  runtimeIdentifier: z.string().min(1).optional(),
});
export type CreateDeviceRequest = z.infer<typeof createDeviceRequestSchema>;

export const launchRequestSchema = z.object({
  bundleId: z.string().min(1),
  args: z.array(z.string()).default([]),
  environment: z.record(z.string(), z.string()).default({}),
  console: z.boolean().default(false),
});
export type LaunchRequest = z.input<typeof launchRequestSchema>;

export const launchResponseSchema = z.object({
  pid: z.number().int().nonnegative(),
});
export type LaunchResponse = z.infer<typeof launchResponseSchema>;

export const terminateRequestSchema = z.object({
  bundleId: z.string().min(1),
});
export type TerminateRequest = z.infer<typeof terminateRequestSchema>;

export const installResponseSchema = z.object({
  installed: z.string().min(1),
});
export type InstallResponse = z.infer<typeof installResponseSchema>;

/** Input coordinates are normalized to the display: (0,0) top-left, (1,1) bottom-right. */
const pointSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
});
export type Point = z.infer<typeof pointSchema>;

export const inputEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), ...pointSchema.shape }),
  z.object({
    type: z.literal("swipe"),
    from: pointSchema,
    to: pointSchema,
    durationMs: z.number().int().positive().max(10_000).default(300),
  }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(10_000) }),
  z.object({ type: z.literal("key"), key: z.string().min(1).max(80) }),
  z.object({
    type: z.literal("button"),
    button: z.enum(["home", "lock", "siri", "side"]),
  }),
]);
export type InputEvent = z.infer<typeof inputEventSchema>;

export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof errorSchema>;

export const screenshotFormatSchema = z.enum(["png", "jpeg"]).default("jpeg");
export type ScreenshotFormat = z.infer<typeof screenshotFormatSchema>;

export const backendNameSchema = z.enum(["simctl", "mock"]);
export type BackendName = z.infer<typeof backendNameSchema>;
