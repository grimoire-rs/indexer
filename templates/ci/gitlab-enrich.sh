      # The index stores pointers; README, changelog, logo and version list all
      # live in the registry, and grim is what reads a registry. Best-effort by
      # design - a registry outage degrades the site to pointers-only rather
      # than blocking a deploy, so the failure is logged and the build
      # continues. Set `"enrich": false` in the `ci` block to drop this block.
      #
      # Nothing is committed and no token is involved: the sidecars live only
      # in this job's workspace, which is why this needs no CI variables.
      #
      # That is also why `--seed` is here. With an empty workspace every digest
      # probe compares against nothing, so every README and payload is
      # downloaded again and every artifact without a `created` of its own is
      # re-dated to this build. `--seed` restores enrich/ from
      # `<site>/enrich.json` - the checkpoint the last deploy published - so the
      # published site is the checkpoint, exactly as it is for the ratings
      # sidecar. An unreadable checkpoint warns and falls back to the full
      # download; it never fails the job.
      if command -v apk >/dev/null 2>&1; then
        apk add --no-cache curl tar
      elif command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq && apt-get install -y -qq --no-install-recommends curl tar ca-certificates
      fi
      # Alpine is musl; everything else here is glibc.
      if [ -f /etc/alpine-release ]; then libc=musl; else libc=gnu; fi
      # Resolved from `ci.grimVersion` when this file was rendered, so there is
      # no version branch left to take at run time.
      base="{{grimReleaseBase}}"
      tarball="grimoire-$(uname -m)-unknown-linux-$libc.tar.gz"
      tmp="$(mktemp -d)"
      ( cd "$tmp" \
        && curl -fsSL --proto '=https' --tlsv1.2 -O "$base/$tarball" -O "$base/$tarball.sha256" \
        && sha256sum -c "$tarball.sha256" \
        && tar -xzf "$tarball" -C /usr/local/bin --strip-components=1 "${tarball%.tar.gz}/grim" ) \
        && npm run enrich -- --seed \
        || echo "warning: enrich failed - building without READMEs, logos and version lists"
