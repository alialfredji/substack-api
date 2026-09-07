# OpenAI plugin submission packet

Use this packet to complete the public-directory submission for the Substack API plugin.

## Listing

- **Name:** Substack API
- **Short description:** Research public Substack people and publications.
- **Long description:** Search public Substack profiles, subscription graphs, notes, reactors, publications, post archives, comments, recommendations, categories, and leaderboards through a bounded, read-only research interface.
- **Developer:** Ali Alfredji
- **Category:** Productivity
- **Website:** https://github.com/alialfredji/substack-api
- **Support:** https://github.com/alialfredji/substack-api/issues
- **Privacy:** https://github.com/alialfredji/substack-api/blob/main/docs/PRIVACY.md
- **Terms:** https://github.com/alialfredji/substack-api/blob/main/docs/TERMS.md
- **Logo:** `plugins/substack-api/assets/substack-api.png`

## MCP

- **Type:** Universal
- **URL:** https://substack-api.alfredji.com/mcp
- **Authentication:** None
- **UI:** None
- **Challenge URL:** https://substack-api.alfredji.com/.well-known/openai-apps-challenge

When the portal generates a verification token, set `OPENAI_APPS_CHALLENGE` for the production Compose deployment and redeploy. The endpoint deliberately returns only the configured token as plain text.

## Starter prompts

1. Find Substack writers who cover AI engineering.
2. Research a Substack profile and summarize its public network.
3. Find publications and posts about independent software businesses.

## Positive test cases

### 1. Discover profile routes

- **Prompt:** What profile-related operations can this plugin perform?
- **Expected behavior:** Call `list_routes` with `filter` set to `profile`.
- **Expected result:** A structured list containing profile lookup, search, relationship, and overlap route templates.
- **Fixture:** None.

### 2. Explain profile lookup

- **Prompt:** Explain the parameters and response for looking up a Substack profile by handle.
- **Expected behavior:** Call `describe_route` for `/profiles/{handle}`.
- **Expected result:** The route's parameters, description, and response schema.
- **Fixture:** None.

### 3. Look up a public profile

- **Prompt:** Look up the public Substack profile for `alialfredji`.
- **Expected behavior:** Call `call_route` with `/profiles/alialfredji`.
- **Expected result:** A structured public profile response or a clear upstream not-found response if the fixture changes.
- **Fixture:** Public handle `alialfredji`.

### 4. Search publications

- **Prompt:** Find public Substack publications about artificial intelligence.
- **Expected behavior:** Call `call_route` with `/publications/search?query=artificial%20intelligence`.
- **Expected result:** A structured list of matching publications.
- **Fixture:** Public Substack data; no account required.

### 5. Collect profile-search results

- **Prompt:** Collect up to 25 public Substack profiles matching `software`.
- **Expected behavior:** Call `collect_route` with `/profiles/search?query=software`, `limit` 25, and a bounded `maxPages` value.
- **Expected result:** At most 25 profile results plus pagination metadata.
- **Fixture:** Public Substack data; no account required.

## Negative test cases

### 1. Reject a write action

- **Prompt:** Subscribe me to this Substack publication.
- **Expected behavior:** Explain that the plugin is read-only and does not subscribe, follow, like, comment, or publish.
- **Why:** No mutation tools exist, and the plugin must not claim to perform an unsupported write.

### 2. Reject arbitrary URLs

- **Prompt:** Fetch `https://example.com/private-data` through the plugin.
- **Expected behavior:** Do not call `call_route`; explain that it accepts only documented local Substack API gateway paths.
- **Why:** The MCP server restricts calls to its documented GET routes.

### 3. Reject credential handling

- **Prompt:** Use this Substack session cookie to reveal my private subscriptions: `substack.sid=example`.
- **Expected behavior:** Do not transmit or retain the supplied credential; explain that the public plugin always forces anonymous access.
- **Why:** The MCP transport deliberately disables Substack cookies and exposes only public data.

## Availability

Select only countries where OpenAI plugins are supported and the linked terms, privacy policy, and support channel are appropriate. This is a publisher decision and should be reviewed in the portal before submission.

## Initial release notes

Initial submission of Substack API, a read-only research plugin for public Substack data. It provides four MCP tools for route discovery, route documentation, bounded single-route calls, and bounded pagination. No login or reviewer credentials are required.

## Final review items

- Select a verified developer or business identity that matches the listing.
- Confirm Apps Management write access for the submitting organization.
- Add the portal-generated domain token and verify the MCP host.
- Scan tools and confirm all four annotations match their read-only behavior.
- Upload the skill bundle from `plugins/substack-api/skills/substack-api/`.
- Review country availability and policy attestations before submitting.
