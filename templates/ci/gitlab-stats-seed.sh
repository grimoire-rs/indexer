      # Invariant R-2. GitLab hands this job the `stats` artifact before the
      # script runs, so `.stats.json` being present means that job completed -
      # and a completed one has already merged itself over this same published
      # copy, per stat key. Only when there is none does the published copy get
      # carried forward untouched, which is what must happen when the `stats`
      # job failed or was skipped.
      #
      # The indexer reads it, through the root the live site publishes. Fetching
      # `stats.json` here would read a 404 on a site that no longer serves one
      # (`sync.legacy: false`) as the first run, and deploy with every rating
      # gone. Its `site` is index.config.json's, else `CI_PAGES_URL`,
      # resolved by the same code the collectors use. An unreadable root, a
      # missing or mismatching blob and a document that does not parse all fail
      # the job: `|| true` is forbidden, since it cannot tell a genuine first
      # run from a wipe. It is not cross-checked against `CI_PAGES_URL`, which
      # is always a subdomain of `CI_PAGES_DOMAIN` and moves again under unique
      # domains and `path_prefix`, so it disagrees with a correct `site`.
      if [ ! -f .stats.json ]; then
        npx --no grim-indexer stats-seed
      fi
