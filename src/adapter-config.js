const pinMeta = { inject: { source: "meta" }, removeProperties: ["source"] };

// Server parameter notes about Spytrend web app pages (/ads, /advertisers, …) and the TikTok corpus do not
// apply to this Meta-only adapter, nor do notes about pixel or IP lookups: such sentences are dropped.
const metaOnly = ["(^|[^\\w.:/-])/[a-z]", "spytrend\\.com/[a-z]", "\\bpixels?\\b", "pixel_id", "resolved_ip", "\\bIPs?\\b", "\\bTikTok\\b"];

const searchProperties = {
  contains_in_links: "match a fragment inside the ad's tracking links, e.g. a sub id or a UTM fragment like 'sub1=' or 'utm_campaign=xyz'",
  advertiser_id: "only ads from this advertiser: the advertiser_id from `search_facebook_advertisers` or from an ad row. A Facebook page id or facebook.com page link is accepted too and applied as page_id.",
  landing_domain: "landing domain filter: matches this hostname and its subdomains. Set landing_domain_exact=true to match the hostname only.",
  hub_domains: "exact destination domains to filter landing pages by (e.g. linktr.ee, wa.me); hub_category is the coarse form. When channel is also set, both lists are combined into one OR-list.",
  sort_by: "order results by: date (default, newest first), most_popular, folder_added or most_reused_creative. most_reused_creative ranks ads by how many ads share the same creative within the selected filters; it needs an anchor filter (advertiser, page, query, landing domain or creative) or a launch window of at most 31 days. folder_added is meaningful only with folder_id or saved=all."
};

// Pixel and IP lookups are internal signals: never published, a call that sets one is refused.
const internalLookups = ["pixel_id", "resolved_ip"];
// Ad rows carry the server's own advertiser entities (an id and the entities matched to the ad):
// internal, not the advertisers this adapter works with. Dropped from every result row.
const serverAdFields = ["webmaster_id", "webmasters"];

export const adapterConfig = {
  rejectProperties: internalLookups,
  source: "meta",
  title: "Facebook Ads Library",
  dropTerms: metaOnly,
  instructions: [
    "Meta (Facebook and Instagram) ad research over the hosted Spytrend database. The source is fixed to Meta.",
    "Typical flow: search_facebook_ads with narrow filters and a small limit, show the rows to the user, open the ones they pick with get_facebook_ad, and call get_facebook_ad_media only for ids the user chose.",
    "To find ads on a website use landing_domain, not the free-text query. For an advertiser use search_facebook_advertisers, then get_facebook_advertiser or search_facebook_ads with advertiser_id.",
    "Use get_facebook_ads_analytics for \"how many / where / what share\" questions; it needs the Pro plan or higher.",
    "Billing is in Spytrend tokens: one per delivered row, fifty to open a multi-language upload; get_usage is free. Do not loop retries on a paid call.",
    "A linked account without a paid plan gets archive data only (ads older than 90 days); responses say so. Tell the user and point to https://spytrend.com/pricing?utm_source=github-facebook-ads-library-mcp&utm_medium=repo&utm_campaign=mcp-launch for live data.",
    "A refusal that names a plan or an account link is a plan requirement, not a server error: report it to the user instead of retrying. Errors carry structuredContent.error with kind and retryable; retry only when retryable is true."
  ].join(" "),
  tools: {
    search_facebook_ads: {
      remoteName: "search_ads",
      ...pinMeta,
      removeProperties: ["source"],
      rejectProperties: ["webmaster_id"],
      dropFields: serverAdFields,
      properties: searchProperties,
      // days_active is a TikTok-only sort on the hosted server.
      enums: { sort_by: ["date", "most_popular", "folder_added", "most_reused_creative"] },
      title: "Search Facebook ads",
      description: "Search Meta (Facebook and Instagram) ads by text, country, category, advertiser or landing domain. Start here: it returns ad ids for the other tools. Meta only — the source is fixed by this adapter; every delivered row costs one Spytrend token."
    },
    get_facebook_ad: {
      remoteName: "get_ad",
      ...pinMeta,
      dropFields: serverAdFields,
      properties: { id: "the ad id from `search_facebook_ads`" },
      title: "Get Facebook ad",
      description: "Open one Meta ad by an id from `search_facebook_ads`: ad copy, destination link, run dates and the creative. One token; fifty for a multi-language upload."
    },
    search_facebook_advertisers: {
      remoteName: "search_advertisers",
      title: "Search Facebook advertisers",
      description: "Find Meta advertiser pages by name or filters and get their ids for `get_facebook_advertiser`. One token per row."
    },
    get_facebook_advertiser: {
      remoteName: "get_advertiser",
      properties: { id: "the advertiser id from `search_facebook_advertisers` or from an ad row" },
      title: "Get Facebook advertiser",
      description: "One Meta advertiser page: ad volume, countries and currently active ads. One token."
    },
    get_facebook_ads_analytics: {
      remoteName: "get_ads_analytics",
      rejectProperties: ["webmaster_id", "favorites_only"],
      // The server's sixth breakdown groups ads by its own advertiser entities: the section and its rows go.
      dropFields: ["webmasters"],
      dropRows: { dimension: ["webmasters"] },
      properties: {
        advertiser_id: "the advertiser id from `search_facebook_advertisers` or from an ad row",
        parsing_geo: "ISO-2 country the ad was collected in",
        contains_in_links: "tracking-link fragment (a sub id or UTM fragment), at most 255 UTF-8 bytes"
      },
      title: "Facebook ads analytics",
      description: "Aggregates over a filtered selection of Meta ads (same filters as `search_facebook_ads`): totals plus breakdowns by status, country, category, landing domain and advertiser instead of a list. Use when the question is \"how many / where / what share\", not \"show me the ads\". Pro plan or higher; one token per delivered breakdown row (10 per section by default, at most 20)."
    },
    find_similar_facebook_ads: {
      remoteName: "find_similar_ads",
      dropFields: serverAdFields,
      title: "Find related Facebook ads",
      description: "Ads related to a given Meta ad id through the same advertiser page or the same landing domain. Use to see the rest of a campaign. One token per row."
    },
    get_facebook_ad_media: {
      remoteName: "get_media",
      properties: {
        entity_type: "'ad' for ad ids from `search_facebook_ads` or `get_facebook_ad`; 'creo' for creative ids (the creative_id field of an ad row, when the row carries one)",
        ids: "1 to 500 ad or creative ids returned by this adapter; malformed ids are reported per item and never consume quota"
      },
      title: "Download Facebook ad media",
      description: "Download the images and videos behind Meta ad or creative ids returned by this adapter. Metered separately from rows."
    },
    get_usage: {
      remoteName: "get_usage",
      title: "Plan and token balance",
      description: "Your Spytrend plan and remaining token quota. Free."
    }
  }
};
