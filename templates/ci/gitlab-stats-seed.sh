
      # Invariant R-2. GitLab hands this job the `stats` artifact before the
      # script runs, so `.stats.json` being present means that job completed -
      # and a completed one has already merged itself over this same published
      # copy, per stat key. Only when there is none does the published copy get
      # carried forward untouched, which is what must happen when the `stats`
      # job failed or was skipped.
      #
      # `|| true` is forbidden here. It cannot tell a genuine 404 from a DNS
      # failure, a TLS error, a 5xx or a truncated body - and if the `stats` job
      # also failed, the deploy would then publish a site with no sidecar at all,
      # the exact wipe R-2 exists to prevent. So the status code is captured
      # and branched on: 404 is an empty seed, a 2xx that parses is the merge
      # base, anything else fails the job.
      #
      # One source. The seed URL is `site` from index.config.json, read out of
      # the checkout here - the same key, the same file and the same run as
      # the job that produced the artifact this one was handed. Not baked in
      # at render time on purpose: a pipeline rendered before `site` was last
      # edited would seed from one URL while the collectors read the other,
      # which is the divergence this step exists to close.
      #
      # Deliberately NOT cross-checked against `CI_PAGES_URL`. That variable
      # is always a subdomain of `CI_PAGES_DOMAIN` and never reflects a custom
      # domain, and unique domains (16.7+) and `path_prefix` (17.9+) move it
      # again - so it disagrees with a correct `site` as the normal case, and
      # comparing them would fail every such deploy. The GitHub arm keeps its
      # cross-check because `steps.pages.outputs.base_url` really is a
      # statement about where the site deploys.
      SITE_URL=$(node -p 'JSON.parse(require("fs").readFileSync("index.config.json","utf8")).site ?? ""')
      rstrip() { u=$1; while [ "${u%/}" != "$u" ]; do u=${u%/}; done; printf '%s' "$u"; }
      SITE_URL=$(rstrip "$SITE_URL")
      case "$SITE_URL" in
        https://*) ;;
        # Not defaulted: the built-in default names the first-party index, and
        # seeding from someone else's published stats would merge their
        # stats into this one's sidecar. TLS because the fetched document
        # decides every published stat - `--proto '=https'` below would
        # refuse it anyway, in curl's words instead of these.
        *)
          echo "grim-indexer: index.config.json needs an explicit https \`site\` - the seed is read from <site>/stats.json (got '$SITE_URL')" >&2
          exit 1
          ;;
      esac

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
          -o .stats.json.seed -w '%{http_code}' "$SITE_URL/stats.json") || {
          echo "grim-indexer: could not read the published stats.json - refusing to deploy a site that would empty every published stat" >&2
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
