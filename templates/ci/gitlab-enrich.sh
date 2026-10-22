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
      # re-dated to this build. `--seed` starts from the state the last deploy
      # published: it reads `<site>/c/root.json` and the enrich plane that root
      # names, so the published site is the checkpoint, exactly as it is for the
      # ratings sidecar. An unreadable root warns and falls back to the full
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
      # The refresh runs in the `then` branch, never in a subshell: its
      # `exit 65` has to end this job, and inside `( ... )` it would only end
      # the subshell and fall through to the best-effort warning below.
      #
      # `GRIM_INDEX_FRESH` and `GRIM_INDEX_PURGE` are pipeline variables a
      # manual run sets. A flag is appended only when its variable is set,
      # since an empty `--purge=` would exit 65 on every scheduled and push run.
      # When one was passed, exit 65 fails the job: a mistyped purge must not
      # deploy the data it was meant to remove. Every other non-zero exit keeps
      # the best-effort warning and deploys the carried-forward state.
      if ( cd "$tmp" \
        && curl -fsSL --proto '=https' --tlsv1.2 -O "$base/$tarball" -O "$base/$tarball.sha256" \
        && sha256sum -c "$tarball.sha256" \
        && tar -xzf "$tarball" -C /usr/local/bin --strip-components=1 "${tarball%.tar.gz}/grim" ); then
        set -- --seed
        strict=
        if [ -n "${GRIM_INDEX_PURGE:-}" ]; then set -- "$@" "--purge=$GRIM_INDEX_PURGE"; strict=1; fi
        if [ "${GRIM_INDEX_FRESH:-}" = true ]; then set -- "$@" --fresh; strict=1; fi
        rc=0
        npm run enrich -- "$@" || rc=$?
        if [ "$rc" -eq 65 ] && [ -n "$strict" ]; then
          echo "enrich rejected --purge or --fresh (exit 65)" >&2
          exit 65
        fi
        [ "$rc" -eq 0 ] || echo "warning: enrich exited $rc - building from the carried-forward state"
      else
        echo "warning: enrich failed - building without READMEs, logos and version lists"
      fi
