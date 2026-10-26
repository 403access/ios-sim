---
title: Architecture dashboard
sidebar_position: 7
description: One screen for the goal, the nine layers, shipped and open work, milestones, and recent progress.
---

# Architecture dashboard

This is the single-screen view of the native track: the goal at the top, the nine layers beneath
it, per-layer shipped and open work, the M1–M3 milestones, and recent commits. Hover or focus a
layer for its detail; click to pin it, `Esc` to release.

It is generated from `scripts/architecture-progress.ts` by `bun run architecture:build`, which
`docs:build` runs before Docusaurus. Update the data when a milestone lands — the layer percentages
and the recent list are the progress record, not a mockup.

import useBaseUrl from "@docusaurus/useBaseUrl";

<div className="dashboard-frame">
  <iframe
    src={useBaseUrl("/architecture-progress.html")}
    title="Architecture and progress dashboard"
    loading="lazy"
  />
</div>

<style>{`
  .dashboard-frame iframe {
    width: 100%;
    height: calc(100vh - var(--ifm-navbar-height) - 4.5rem);
    min-height: 640px;
    border: 0;
    border-radius: 14px;
    background: #060a12;
    box-shadow: 0 24px 60px rgba(2, 6, 23, 0.35);
  }
`}</style>
