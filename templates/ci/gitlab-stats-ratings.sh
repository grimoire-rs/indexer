    # The tally needs a token that may write reactions: set GRIM_RATINGS_TOKEN
    # as a masked CI/CD variable (a project access token with `api` scope is
    # enough, since the threads live in this same project). CI_JOB_TOKEN cannot
    # do it - it inherits the triggering user's identity.
    - npx --no grim-indexer ratings
