---
id: maps
title: Maps and self-hosted tiles
summary: Choose where map views get their map, host the tiles yourself, or turn maps off.
area: administration
order: 3
level: advanced
related: [views]
---

Map views draw each record's place on a map.  The map itself comes from a map style: a file that names where the map's tiles, fonts, and symbols live.  Riosoma uses OpenFreeMap's free Liberty style unless you set `RIOSOMA_MAP_STYLE_URL` to another one.

```
RIOSOMA_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty
```

Each person's browser asks the style's host for the map as they move around it, so that host learns their address and the places they look at.  Nothing about the records goes to it.  To keep even that inside your network, host the tiles yourself.

## Hosting the tiles yourself

Any map server that serves a MapLibre style works, such as OpenFreeMap's own server, which you can run on your own machine.  Point `RIOSOMA_MAP_STYLE_URL` at its style:

```
RIOSOMA_MAP_STYLE_URL=https://maps.example.com/styles/liberty
```

Riosoma's content security policy lets browsers reach the style's host and no other, so serve the style, tiles, fonts, and symbols from that one host, as OpenFreeMap does.  A style that sends browsers anywhere else draws an incomplete map.  Use `https` when people reach Riosoma over `https`, since browsers block a map from a plain `http` address on a secure page.  Leave usernames and keys out of the address, since every browser that opens a map view reads it.

## Turning maps off

With `RIOSOMA_MAP_STYLE_URL=off`, no browser asks any map host for anything.  Map views then list each record with its place instead, with a short note that maps are off.  Everything else about the view works the same: its filter, the fields each record shows, and the records with no location.

The setting takes effect when Riosoma restarts.
