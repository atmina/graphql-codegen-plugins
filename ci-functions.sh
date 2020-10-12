function set_npm_auth_config() {
  {
    echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}"
  } >> .npmrc
}

function create_and_push_commit() {
  BRANCH_NAME="bump_version_${CI_PIPELINE_IID}"
  git checkout -b "$BRANCH_NAME"
  git add .
  git config user.name "$GITLAB_USER_NAME"
  git config user.email "$GITLAB_USER_EMAIL"
  git commit -m "Version bump"
  git remote set-url origin "https://gitlab-ci-token:$GITLAB_PUSH_TOKEN@$CI_SERVER_HOST/$CI_PROJECT_PATH.git"
  git push -u origin "$BRANCH_NAME"
}

function create_mr() {
  BRANCH_NAME="bump_version_${CI_PIPELINE_IID}"
  BODY="{
    \"id\": ${CI_PROJECT_ID},
    \"source_branch\": \"${BRANCH_NAME}\",
    \"target_branch\": \"${CI_DEFAULT_BRANCH}\",
    \"remove_source_branch\": true,
    \"title\": \"Version bump prior release\",
    \"allow_collaboration\": false
  }";

  curl -X POST "${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/merge_requests" \
    --header "Authorization: Bearer ${GITLAB_PUSH_TOKEN}" \
    --header "Content-Type: application/json" \
    --data "${BODY}"
}
