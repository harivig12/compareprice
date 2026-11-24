# Docker disk clean-up plan (2026-11-20). Prepared, nothing removed yet

## Why

- The root disk is at **97%** (428 GB used, 17 GB free).
- `docker system df` reports 57.2 GB of images, with 36.8 GB reclaimable, plus 5.5 GB of container layers and 0.8 GB of volumes.

## Rules for this clean-up (user, 2026-11-20)

- **Jhola's data and cache stay**:
  - `/home/a/basket-data` (bind mount): `basket.db`, `chrome-profile`, `profiles/`, `cache/`, `accounts.json`, `secrets.json`, `ai.md`, `basket.txt`, `results/`, `master/`;
  - the running image `compareprice:latest`;
  - the build base `node:24-slim`;
  - the old Docker volume `basket-data` (see Tier 3).
- No volume is removed in Tier 1 or Tier 2.
- Every command below names the exact images or containers. None of them uses `docker system prune`, `--volumes` or `-a`.

## Measured (`docker system df -v`, 2026-11-20)

"Unique" is what removing an item would actually free. Shared layers stay as long as another image uses them.

### Tier 1: old Jhola builds (safe; this project only)

- 27 untagged `compareprice` builds, each left behind by a rebuild. Every one has **~385 MB unique**, so **~10.4 GB** in total.
- None has a container, and none is the running image (`5004bd7f5e95`).
- One small image pulled during this survey: `alpine:latest`, 13 MB, used once to list the old `basket-data` volume read-only.

```bash
docker rmi c267edc791ae 55d8c72a58ea 4da4d451a316 7482845886d0 34a30d621c5e fa9f1e63a373 e9d5534d84d2 \
  1c0fa6b2c1ae afe726936761 cb296d8fcc11 34f4a7052c31 9dd896d69f6d dea9ac7b1cea 7e988740b36f 90f176a71470 \
  3ff6782ac86d 7abf481aaff9 eebb879c7119 6a0116b9b8d0 32403a3419aa dcfdc1b95e96 45ae0a40f8a2 7fc16bcb4ab2 \
  514fd509d46e 8b75877b7dc0 19fc848b06e5 31bb2bbefaee
docker rmi alpine:latest
```

The running service is unaffected, because `docker rmi` refuses an image a container uses. After this, the next `docker build` still uses its layer cache through `compareprice:latest` and `node:24-slim`.

### Tier 2: other projects' images and stopped containers (your call, one by one)

| Item | Frees | State | Note |
|---|---|---|---|
| image `ccer-flutter-release:prepared` (`0c0c1f8ea4d2`) | ~9.7 GB unique | no container, 2 weeks old | Flutter build image from the dashboard work. Rebuildable |
| container `ccer-flutter-release` | 5.29 GB writable layer | exited (1) 2 weeks ago | **Holds whatever that build left inside.** Check before removing. Its image `cirruslabs/flutter:stable` (2.28 GB unique) can go with it |
| image `snapotter/snapotter:latest` + `SnapOtter`, `SnapOtter-postgres`, `SnapOtter-redis` containers | ~12.3 GB + 0.56 GB | all exited 6 weeks ago | Its data volume `otter_snapotter_data` (480 MB) is **kept** unless you say otherwise |
| `immich-slideshow-old-devices` container + image | ~0.8 GB | exited 3 months ago | |
| untagged image `d6fc22a86c43` | 239 MB | no container, 3 weeks old | Origin unknown, not Jhola's (Jhola builds are 1.44 GB) |

Kept, not listed for removal:
- the running services (immich ML, open-webui, kokoro, metube, homarr, glance, portainer, selfie-timelapse);
- `qBittorrent` and the two `immich-kiosk` containers, which are stopped but recently used.

### Tier 3: volumes (kept)

| Volume | Size | What it is |
|---|---|---|
| `basket-data` | 166 MB | An **old Jhola data volume** from 2026-11-18, before the service moved to the `/home/a/basket-data` bind mount: an early `basket.db`, `chrome-profile`, `results/`. Kept, per "never delete data". |
| `ccer-pub-cache` | 190 MB | Flutter package cache |
| `otter_snapotter_data` | 480 MB | SnapOtter data |
| `portainer_data` | 0.5 MB | In use |

## Why each rebuild costs ~385 MB

The Dockerfile already orders its layers for caching: Chromium apt, then `npm ci`, then `src`. `docker history` shows the layers that change are small: `src` 848 kB and `basket.txt` 12 kB.

Even so, every untagged build reports ~385 MB unique. These builds run on Docker's **legacy builder** ("DEPRECATED: The legacy builder…" on every build) with the containerd image store, and the likely cause is that this combination stores a new copy of content each time. This is **not verified**.

Options:
1. **Remove the previous build after each deploy (no system change).** Tag the running image as `compareprice:previous` before `docker build`; after a healthy start of the new one, `docker rmi` the old ID. That keeps at most one spare.
2. **Install BuildKit** (`docker-buildx-plugin`). It's the supported builder and may stop the duplication, but it's a host package change and needs its own check.

## Done (2026-11-20, Tier 1 approved)

**Freed ~2.4 GB, not the ~10.4 GB estimated above.** Free space went 17.0 → 19.4 GB.
- The "~385 MB unique" per old build was misleading. The legacy builder chains every build to parent intermediate images, and `docker system df -v` counted the same Chromium content once per image.
- Removing the 27 listed IDs exposed their parents as new untagged images. 133 Jhola intermediate records went over 12 passes, each one checked before removal: `/app` working dir or `BASKET_*` env, created 2026-11-18 or later, no container.
- The only real space came from two old Chromium layers (~1.15 GB each).
- Also removed: `alpine:latest` (13 MB, pulled by this survey).

**Kept:**
- `compareprice:latest` and `node:24-slim`;
- all volumes, including the old `basket-data`;
- every other project's images and containers;
- `d6fc22a86c43` (Oct 30, not Jhola, Tier 2).

**Checks after:** `/health` ok on 192.168.0.107; cached "ghee" 8/8 sites ok; `/home/a/basket-data` unchanged.

### Root cause, confirmed

`docker history` shows the Chromium `apt-get` layer (775 MB) of two back-to-back builds created 5 minutes apart, with no code change in between. The **legacy builder doesn't reuse its layer cache** on this host (Docker 29.1.3, containerd image store, no buildx installed). So every deploy:
- reinstalls Chromium: slow, and downloads ~250 MB of packages;
- used to leave ~1.1 GB behind.

### Fix in place: `scripts/deploy.sh`

The script:
1. Runs `npm test`, and waits if a job is running.
2. Tags the running image as `compareprice:previous`.
3. Builds, restarts with the same flags, and waits up to 60 s for `/health`. If the new build isn't healthy, it **rolls back** to `:previous`.
4. On success, prunes only untagged images labelled `org.opencontainers.image.title=jhola`. The label was added to the Dockerfile and covers intermediates too.

The disk now holds at most two Chromium copies (latest plus the rollback). Measured: a second, no-change deploy used 1.1 GB, and the tidy step left the total flat.

### Still open: needs a host package (your approval)

Install BuildKit so the Chromium layer is cached:

```bash
sudo apt install docker-buildx   # Ubuntu 24.04 candidate: 0.30.1-0ubuntu1~24.04.1
```

Expected, not measured: a deploy drops from re-installing Chromium to copying `src/` only, and each deploy stops adding 1.1 GB. Check after installing: run `scripts/deploy.sh` twice and compare `docker history` timestamps and free space.
