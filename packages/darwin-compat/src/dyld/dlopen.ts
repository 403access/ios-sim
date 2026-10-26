/**
 * Dynamic image handles for `dlopen`/`dlsym`/`dlclose` (LDR-004).
 *
 * This is the semantic layer: one `ImageLoader` owns the address space and
 * image cache, while `DynamicLoader` tracks per-image reference counts and
 * unmaps an image only when the last handle closes and the image was not part
 * of the main program graph.
 *
 * Not implemented here: `RTLD_GLOBAL` promotion, `RTLD_NEXT`/`RTLD_DEFAULT`
 * interposition, constructors on `dlopen`, and symbol versioning. Those are
 * later loader tasks; returning null/unsupported is deliberate.
 */

import { normalize } from "node:path";
import { LoaderError } from "../errors.js";
import { ImageLoader, resolveImageExport, type LoadedImage } from "./loader.js";

export interface DylibHandle {
  readonly id: number;
  readonly path: string;
}

interface Entry {
  readonly path: string;
  readonly image: LoadedImage;
  refs: number;
}

export class DynamicLoader {
  private readonly entries = new Map<string, Entry>();
  private readonly handles = new Map<number, Entry>();
  private nextHandle = 1;

  constructor(private readonly loader: ImageLoader) {}

  /** Open a dylib, incrementing its reference count and its dependencies'. */
  open(path: string): DylibHandle {
    const normalized = normalize(path);
    let entry = this.entries.get(normalized);
    if (entry) {
      entry.refs += 1;
    } else {
      const image = this.loader.loadDylib(normalized);
      entry = { path: normalized, image, refs: 1 };
      this.entries.set(normalized, entry);
      this.retainDependencies(image);
    }
    const id = this.nextHandle++;
    this.handles.set(id, entry);
    return { id, path: entry.path };
  }

  /** Resolve a symbol in the opened image and its reexport chain. */
  symbol(handle: DylibHandle, name: string): bigint | null {
    const entry = this.handles.get(handle.id);
    if (!entry) throw new LoaderError("bad_handle", `dlopen handle ${handle.id} is not open`);
    return resolveImageExport(entry.image, name);
  }

  /** Close one handle. Returns true when the image was unloaded. */
  close(handle: DylibHandle): boolean {
    const entry = this.handles.get(handle.id);
    if (!entry) return false;
    this.handles.delete(handle.id);
    entry.refs -= 1;
    if (entry.refs > 0) return false;
    return this.release(entry);
  }

  /** Close every open handle, used by process teardown and tests. */
  closeAll(): void {
    for (const id of [...this.handles.keys()]) {
      this.close({ id, path: this.handles.get(id)?.path ?? "" });
    }
  }

  isLoaded(path: string): boolean {
    return this.entries.has(normalize(path));
  }

  refCount(path: string): number {
    return this.entries.get(normalize(path))?.refs ?? 0;
  }

  loadedPaths(): string[] {
    return [...this.entries.keys()];
  }

  private retainDependencies(image: LoadedImage): void {
    const seen = new Set<string>();
    const visit = (candidate: LoadedImage): void => {
      for (const dependency of candidate.dependencies) {
        if (!dependency || seen.has(dependency.path)) continue;
        seen.add(dependency.path);
        let entry = this.entries.get(dependency.path);
        if (entry) {
          entry.refs += 1;
        } else {
          entry = { path: dependency.path, image: dependency, refs: 1 };
          this.entries.set(dependency.path, entry);
        }
        visit(dependency);
      }
    };
    visit(image);
  }

  private release(entry: Entry): boolean {
    const seen = new Set<string>();
    const visit = (candidate: Entry): void => {
      if (seen.has(candidate.path)) return;
      seen.add(candidate.path);
      for (const dependency of candidate.image.dependencies) {
        if (!dependency) continue;
        const child = this.entries.get(dependency.path);
        if (!child) continue;
        child.refs -= 1;
        if (child.refs <= 0) visit(child);
      }
      this.entries.delete(candidate.path);
      this.loader.unloadImage(candidate.path);
    };
    visit(entry);
    return true;
  }
}
