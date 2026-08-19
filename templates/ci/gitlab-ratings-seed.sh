
      # Invariant R-2. GitLab hands this job the ratings artifact before the
      # script runs, so `.stats.json` being present means a tally completed -
      # and a completed tally has already merged itself over this same
      # published copy, per stat key. Only when there is none does the
      # published copy get carried forward untouched, which is what must happen
      # when the tally failed or was skipped.
      #
      # `|| true` is forbidden here. It cannot tell a genuine 404 from a DNS
      # failure, a TLS error, a 5xx or a truncated body - and if the tally also
      # failed, the deploy would then publish a site with no sidecar at all,
      # the exact wipe R-2 exists to prevent. So the status code is captured
      # and branched on: 404 is an empty seed, a 2xx that parses is the merge
      # base, anything else fails the job.
      #
      # `node:*-alpine` ships no curl, and the runner's clone helper is a
      # separate image, so nothing else puts one here. Install it for whichever
      # package manager this image has, then insist it is really there - a
      # missing tool must fail the job, never silently skip the seed.
      if [ ! -f .stats.json ]; then
        if ! command -v curl >/dev/null 2>&1; then
          if command -v apk >/dev/null 2>&1; then
            apk add --no-cache curl
          elif command -v apt-get >/dev/null 2>&1; then
            apt-get update -qq && apt-get install -y -qq --no-install-recommends curl
          fi
        fi
        command -v curl >/dev/null 2>&1 || {
          echo "grim-indexer: seeding stats.json needs curl, and this image has none" >&2
          exit 1
        }
        code=$(curl -sS --proto '=https' --tlsv1.2 --max-time 30 \
          -o .stats.json.seed -w '%{http_code}' "${CI_PAGES_URL%/}/stats.json") || {
          echo "grim-indexer: could not read the published stats.json - refusing to deploy a site that would empty every published rating" >&2
          exit 1
        }
        case "$code" in
          404)
            echo "grim-indexer: no stats.json published yet - starting from an empty seed"
            ;;
          2??)
            node -e 'JSON.parse(require("fs").readFileSync(".stats.json.seed","utf8"))' || {
              echo "grim-indexer: the published stats.json did not parse - refusing to treat an unreadable seed as an empty one" >&2
              exit 1
            }
            mv -f .stats.json.seed .stats.json
            ;;
          *)
            echo "grim-indexer: the published stats.json returned HTTP $code" >&2
            exit 1
            ;;
        esac
      fi
