require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const path = require('path');
const crypto = require('crypto');

const app = express();

app.use(helmet({
  contentSecurityPolicy: false,
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

const {
  PIPEDRIVE_API_TOKEN,
  PIPEDRIVE_COMPANY_DOMAIN,
  TOKEN_FIELD_KEY,
  PREFERENCES_FIELD_KEY,
  WEBHOOK_SECRET,
  PORT = 8080,
} = process.env;

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

requireEnv('PIPEDRIVE_API_TOKEN', PIPEDRIVE_API_TOKEN);
requireEnv('PIPEDRIVE_COMPANY_DOMAIN', PIPEDRIVE_COMPANY_DOMAIN);
requireEnv('TOKEN_FIELD_KEY', TOKEN_FIELD_KEY);
requireEnv('PREFERENCES_FIELD_KEY', PREFERENCES_FIELD_KEY);
requireEnv('WEBHOOK_SECRET', WEBHOOK_SECRET);

/**
 * These are the Pipedrive option IDs currently managed
 * through the public Communications Preferences Centre.
 */
const GENERAL_OPTIONS = [
  {
    id: 541,
    slug: 'general-programme-information',
    label: 'General Programme Information',
  },
  {
    id: 505,
    slug: 'newsletters',
    label: 'Newsletters',
  },
  {
    id: 507,
    slug: 'events',
    label: 'Events',
  },
];

const CATEGORY_OPTIONS = [
  ...GENERAL_OPTIONS,
];

const MANAGED_OPTION_IDS = new Set(
  CATEGORY_OPTIONS.map((option) => String(option.id))
);

const API_BASE = `https://${PIPEDRIVE_COMPANY_DOMAIN}.pipedrive.com/api/v1`;

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseSetValue(rawValue) {
  if (!rawValue) return [];

  if (Array.isArray(rawValue)) {
    return rawValue.map(String);
  }

  if (typeof rawValue === 'object') {
    if (Array.isArray(rawValue.values)) {
      return rawValue.values.map(String);
    }

    return Object.values(rawValue).flat().map(String);
  }

  return String(rawValue)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function personHasEmail(person = {}) {
  const email = person.email;

  if (!email) return false;

  if (Array.isArray(email)) {
    return email.some((item) => {
      if (typeof item === 'string') {
        return item.trim().length > 0;
      }

      return String(item?.value || '').trim().length > 0;
    });
  }

  return String(email).trim().length > 0;
}

function getSecretFromRequest(req) {
  return String(
    req.query.secret ||
    req.headers['x-webhook-secret'] ||
    req.headers['x-admin-secret'] ||
    ''
  ).trim();
}

function isAuthorisedRequest(req) {
  const suppliedSecret = getSecretFromRequest(req);

  return suppliedSecret && suppliedSecret === WEBHOOK_SECRET;
}

function extractPersonIdFromWebhook(body = {}) {
  return (
    body?.data?.id ||
    body?.current?.id ||
    body?.id ||
    body?.person_id ||
    body?.meta?.entity_id ||
    body?.meta?.entityId ||
    null
  );
}

async function pipedriveRequest(apiPath, options = {}) {
  const url = new URL(`${API_BASE}${apiPath}`);
  url.searchParams.set('api_token', PIPEDRIVE_API_TOKEN);

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.success === false) {
    const message =
      body?.error ||
      body?.error_info ||
      response.statusText;

    throw new Error(`Pipedrive API error: ${message}`);
  }

  return body;
}

async function findPersonByToken(token) {
  const searchPath =
    `/persons/search?term=${encodeURIComponent(token)}` +
    `&fields=custom_fields&exact_match=1&limit=10`;

  const searchResult = await pipedriveRequest(searchPath);
  const items = searchResult?.data?.items || [];

  for (const item of items) {
    const personId = item?.item?.id;

    if (!personId) continue;

    const personResult = await pipedriveRequest(`/persons/${personId}`);
    const person = personResult?.data;

    if (
      person &&
      String(person[TOKEN_FIELD_KEY]) === String(token)
    ) {
      return person;
    }
  }

  return null;
}

async function updatePersonPreferences(
  personId,
  selectedOptionIds
) {
  const value = selectedOptionIds.length
    ? selectedOptionIds.join(',')
    : null;

  return pipedriveRequest(`/persons/${personId}`, {
    method: 'PUT',
    body: JSON.stringify({
      [PREFERENCES_FIELD_KEY]: value,
    }),
  });
}

async function ensurePreferenceTokenForPerson(personId) {
  if (!personId) {
    return {
      ok: false,
      action: 'missing_person_id',
    };
  }

  const personResult = await pipedriveRequest(
    `/persons/${personId}`
  );

  const person = personResult?.data;

  if (!person) {
    return {
      ok: false,
      action: 'person_not_found',
      personId,
    };
  }

  const existingToken = String(
    person[TOKEN_FIELD_KEY] || ''
  ).trim();

  if (existingToken) {
    return {
      ok: true,
      action: 'token_already_exists',
      personId,
    };
  }

  if (!personHasEmail(person)) {
    return {
      ok: true,
      action: 'skipped_no_email',
      personId,
    };
  }

  const newToken = crypto.randomUUID();

  await pipedriveRequest(`/persons/${personId}`, {
    method: 'PUT',
    body: JSON.stringify({
      [TOKEN_FIELD_KEY]: newToken,
    }),
  });

  return {
    ok: true,
    action: 'token_created',
    personId,
  };
}

async function fillMissingTokens({
  dryRun = false,
  maxCreated = 250,
} = {}) {
  let start = 0;
  const pageLimit = 100;

  const summary = {
    ok: true,
    dryRun,
    scanned: 0,
    peopleWithEmail: 0,
    peopleWithoutEmail: 0,
    existingTokens: 0,
    missingTokens: 0,
    tokensCreated: 0,
    errors: [],
    stoppedBecauseLimitReached: false,
  };

  while (start !== null && start !== undefined) {
    const peopleResult = await pipedriveRequest(
      `/persons?start=${start}&limit=${pageLimit}`
    );

    const people = peopleResult?.data || [];

    for (const person of people) {
      summary.scanned += 1;

      const personId = person?.id;

      if (!personHasEmail(person)) {
        summary.peopleWithoutEmail += 1;
        continue;
      }

      summary.peopleWithEmail += 1;

      const existingToken = String(
        person[TOKEN_FIELD_KEY] || ''
      ).trim();

      if (existingToken) {
        summary.existingTokens += 1;
        continue;
      }

      summary.missingTokens += 1;

      if (dryRun) {
        continue;
      }

      if (summary.tokensCreated >= maxCreated) {
        summary.stoppedBecauseLimitReached = true;
        return summary;
      }

      try {
        const newToken = crypto.randomUUID();

        await pipedriveRequest(`/persons/${personId}`, {
          method: 'PUT',
          body: JSON.stringify({
            [TOKEN_FIELD_KEY]: newToken,
          }),
        });

        summary.tokensCreated += 1;
      } catch (error) {
        summary.errors.push({
          personId,
          error: error.message,
        });
      }
    }

    const pagination =
      peopleResult?.additional_data?.pagination;

    if (
      pagination?.more_items_in_collection &&
      pagination?.next_start !== undefined
    ) {
      start = pagination.next_start;
    } else {
      start = null;
    }
  }

  return summary;
}

function renderBrandHeader() {
  return `
    <div class="brand">
      <img
        src="/public/2b-logo.png"
        alt="2b Limitless logo"
      >
      <div class="brand-text">
        <div class="brand-name">
          Communications Preferences Centre
        </div>
      </div>
    </div>
  `;
}

function renderCheckboxes(
  options,
  selectedIds = []
) {
  return options
    .map((option) => {
      const optionId = String(option.id);

      const checked = selectedIds.includes(optionId)
        ? 'checked'
        : '';

      return `
        <label class="option">
          <input
            type="checkbox"
            name="categories"
            value="${escapeHtml(optionId)}"
            ${checked}
          >
          <span>${escapeHtml(option.label)}</span>
        </label>
      `;
    })
    .join('');
}

function renderPage({
  token,
  person,
  selectedIds = [],
  success = false,
  error = '',
}) {
  const title = 'Manage your email preferences';

  const generalCheckboxes = renderCheckboxes(
    GENERAL_OPTIONS,
    selectedIds
  );

  const successHtml = success
    ? `
      <div class="notice success">
        Your email preferences have been updated.
      </div>
    `
    : '';

  const errorHtml = error
    ? `
      <div class="notice error">
        ${escapeHtml(error)}
      </div>
    `
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>
    Communications Preferences Centre
  </title>

  <style>
    :root {
      --brand: #a4c814;
      --brand-dark: #82a00f;
      --ink: #243043;
      --muted: #667085;
      --border: #e7eaf0;
      --bg: #f5f7fa;
      --white: #ffffff;
      --success-bg: #ecfdf3;
      --success-border: #abefc6;
      --success-text: #067647;
      --error-bg: #fef3f2;
      --error-border: #fecdca;
      --error-text: #b42318;
    }

    * {
      box-sizing: border-box;
    }

    body {
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        Inter,
        Arial,
        sans-serif;

      background:
        radial-gradient(
          circle at top left,
          rgba(164, 200, 20, 0.12),
          transparent 34%
        ),
        linear-gradient(
          180deg,
          #f7f9fc 0%,
          #f3f5f8 100%
        );

      color: var(--ink);
      margin: 0;
    }

    .wrap {
      max-width: 760px;
      margin: 48px auto;
      padding: 0 20px;
    }

    .card {
      background: var(--white);
      border: 1px solid var(--border);
      border-radius: 22px;
      padding: 38px;

      box-shadow:
        0 18px 45px
        rgba(16, 24, 40, 0.08);

      overflow: hidden;
      position: relative;
    }

    .card::before {
      content: "";
      display: block;
      height: 7px;
      background: var(--brand);

      position: absolute;
      top: 0;
      left: 0;
      right: 0;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 22px;
    }

    .brand img {
      width: 72px;
      height: auto;
      display: block;
    }

    .brand-text {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .brand-name {
      font-size: 18px;
      font-weight: 700;
      color: var(--ink);
    }

    h1 {
      margin: 8px 0 10px;
      font-size: 36px;
      line-height: 1.1;
      color: var(--ink);
    }

    .intro {
      line-height: 1.6;
      color: var(--muted);
      font-size: 17px;
      margin-bottom: 16px;
    }

    .intro-strong {
      line-height: 1.6;
      color: var(--ink);
      font-size: 17px;
      font-weight: 700;
      margin: 0 0 24px;
    }

    .preference-section {
      margin-top: 22px;
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      background: #ffffff;
    }

    .section-title {
      margin: 0 0 12px;
      font-size: 18px;
      line-height: 1.3;
      color: var(--ink);
    }

    .options {
      border-top: 1px solid var(--border);
    }

    .option {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 18px 0;

      border-bottom:
        1px solid var(--border);

      font-size: 18px;
      color: var(--ink);
      cursor: pointer;
    }

    .option:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }

    .option input {
      width: 22px;
      height: 22px;
      accent-color: var(--brand);
      cursor: pointer;
      flex: 0 0 auto;
    }

    .option span {
      line-height: 1.4;
    }

    .buttons {
      display: flex;
      gap: 12px;
      margin-top: 28px;
      align-items: center;
    }

    button {
      border: 0;
      border-radius: 12px;
      padding: 14px 22px;

      font-weight: 800;
      cursor: pointer;
      background: var(--brand);
      color: #1e293b;
      font-size: 16px;

      transition: all 0.2s ease;

      box-shadow:
        0 4px 14px
        rgba(164, 200, 20, 0.22);
    }

    button:hover {
      background: var(--brand-dark);
      color: #ffffff;
      transform: translateY(-1px);
    }

    .small {
      font-size: 13px;
      color: var(--muted);
      margin-top: 24px;
      line-height: 1.6;
    }

    .notice {
      border-radius: 12px;
      padding: 14px 16px;
      margin: 18px 0 22px;

      font-size: 15px;
      line-height: 1.5;
    }

    .success {
      background: var(--success-bg);
      color: var(--success-text);
      border: 1px solid var(--success-border);
    }

    .error {
      background: var(--error-bg);
      color: var(--error-text);
      border: 1px solid var(--error-border);
    }

    @media (max-width: 640px) {
      .wrap {
        margin: 24px auto;
      }

      .card {
        padding: 26px;
        border-radius: 18px;
      }

      .brand {
        gap: 12px;
        align-items: flex-start;
      }

      .brand img {
        width: 56px;
      }

      h1 {
        font-size: 30px;
      }

      .intro,
      .intro-strong {
        font-size: 16px;
      }

      .preference-section {
        padding: 16px;
      }

      .section-title {
        font-size: 17px;
      }

      .option {
        font-size: 16px;
      }

      button {
        width: 100%;
      }
    }
  </style>
</head>

<body>
  <main class="wrap">
    <section class="card">

      ${renderBrandHeader()}

      <h1>${title}</h1>

      <p class="intro">
        We’re sorry that you need to hear from us less,
        but we understand. Life is busy, and sometimes
        you just need to create some space.
      </p>

      <p class="intro-strong">
        Please review the email categories below and
        untick the ones you would like to unsubscribe from.
      </p>

      ${successHtml}
      ${errorHtml}

      <form
        method="post"
        action="/preferences"
      >
        <input
          type="hidden"
          name="token"
          value="${escapeHtml(token)}"
        >

        <div class="preference-section">

          <h2 class="section-title">
            General email preferences
          </h2>

          <div class="options">
            ${generalCheckboxes}
          </div>

        </div>

        <div class="buttons">
          <button type="submit">
            Save preferences
          </button>
        </div>

      </form>

      <p class="small">
        Please be aware that we cannot unsubscribe you
        from transactional emails or emails relating to
        a programme you are currently enrolled in.
      </p>

    </section>
  </main>
</body>
</html>`;
}

function renderError(message) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>
    Communications Preferences Centre
  </title>

  <style>
    :root {
      --brand: #a4c814;
      --brand-dark: #82a00f;
      --ink: #243043;
      --muted: #667085;
      --border: #e7eaf0;
      --white: #ffffff;
    }

    * {
      box-sizing: border-box;
    }

    body {
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        Inter,
        Arial,
        sans-serif;

      background:
        radial-gradient(
          circle at top left,
          rgba(164, 200, 20, 0.12),
          transparent 34%
        ),
        linear-gradient(
          180deg,
          #f7f9fc 0%,
          #f3f5f8 100%
        );

      margin: 0;
      color: var(--ink);
    }

    .card {
      max-width: 680px;
      margin: 60px auto;
      background: var(--white);

      border:
        1px solid var(--border);

      border-radius: 22px;
      padding: 34px;

      box-shadow:
        0 18px 45px
        rgba(16, 24, 40, 0.08);

      position: relative;
      overflow: hidden;
    }

    .card::before {
      content: "";
      display: block;
      height: 7px;
      background: var(--brand);

      position: absolute;
      top: 0;
      left: 0;
      right: 0;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 18px;
    }

    .brand img {
      width: 64px;
      height: auto;
      display: block;
    }

    .brand-name {
      font-size: 18px;
      font-weight: 700;
      color: var(--ink);
    }

    h1 {
      margin: 8px 0 12px;
      font-size: 32px;
      line-height: 1.15;
    }

    p {
      color: var(--muted);
      line-height: 1.6;
      font-size: 16px;
    }
  </style>
</head>

<body>
  <section class="card">

    <div class="brand">

      <img
        src="/public/2b-logo.png"
        alt="2b Limitless logo"
      >

      <div class="brand-name">
        Communications Preferences Centre
      </div>

    </div>

    <h1>
      We couldn’t open your preferences
    </h1>

    <p>
      ${escapeHtml(message)}
    </p>

  </section>
</body>
</html>`;
}

function renderHome() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>
    Communications Preferences Centre
  </title>

  <style>
    :root {
      --brand: #a4c814;
      --brand-dark: #82a00f;
      --ink: #243043;
      --muted: #667085;
      --border: #e7eaf0;
      --white: #ffffff;
    }

    * {
      box-sizing: border-box;
    }

    body {
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        Inter,
        Arial,
        sans-serif;

      background:
        radial-gradient(
          circle at top left,
          rgba(164, 200, 20, 0.12),
          transparent 34%
        ),
        linear-gradient(
          180deg,
          #f7f9fc 0%,
          #f3f5f8 100%
        );

      color: var(--ink);
      margin: 0;
    }

    .card {
      max-width: 680px;
      margin: 60px auto;
      background: var(--white);

      border:
        1px solid var(--border);

      border-radius: 22px;
      padding: 34px;

      box-shadow:
        0 18px 45px
        rgba(16, 24, 40, 0.08);

      position: relative;
      overflow: hidden;
    }

    .card::before {
      content: "";
      display: block;
      height: 7px;
      background: var(--brand);

      position: absolute;
      top: 0;
      left: 0;
      right: 0;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 18px;
    }

    .brand img {
      width: 64px;
      height: auto;
      display: block;
    }

    .brand-name {
      font-size: 18px;
      font-weight: 700;
      color: var(--ink);
    }

    h1 {
      margin: 8px 0 12px;
      font-size: 32px;
      line-height: 1.15;
    }

    p {
      color: var(--muted);
      line-height: 1.6;
      font-size: 16px;
    }
  </style>
</head>

<body>
  <section class="card">

    <div class="brand">

      <img
        src="/public/2b-logo.png"
        alt="2b Limitless logo"
      >

      <div class="brand-name">
        Communications Preferences Centre
      </div>

    </div>

    <h1>
      Communications preferences
    </h1>

    <p>
      Please use the personalised preference link from
      the email you received to manage your communications
      preferences.
    </p>

  </section>
</body>
</html>`;
}

/**
 * Home page
 */
app.get('/', (req, res) => {
  res.send(renderHome());
});

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
  });
});

/**
 * Load preferences page
 */
app.get('/preferences', async (req, res) => {
  try {
    const token = String(
      req.query.token || ''
    ).trim();

    if (!token) {
      return res
        .status(400)
        .send(
          renderError(
            'The preference link is missing a token.'
          )
        );
    }

    const person = await findPersonByToken(token);

    if (!person) {
      return res
        .status(404)
        .send(
          renderError(
            'This preference link is invalid or has expired.'
          )
        );
    }

    const selectedIds = parseSetValue(
      person[PREFERENCES_FIELD_KEY]
    );

    return res.send(
      renderPage({
        token,
        person,
        selectedIds,
      })
    );
  } catch (error) {
    console.error(error);

    return res
      .status(500)
      .send(
        renderError(
          'Something went wrong while loading your preferences.'
        )
      );
  }
});

/**
 * Save preferences
 */
app.post('/preferences', async (req, res) => {
  try {
    const token = String(
      req.body.token || ''
    ).trim();

    if (!token) {
      return res
        .status(400)
        .send(
          renderError(
            'The preference form is missing a token.'
          )
        );
    }

    const person = await findPersonByToken(token);

    if (!person) {
      return res
        .status(404)
        .send(
          renderError(
            'This preference link is invalid or has expired.'
          )
        );
    }

    const requested = Array.isArray(
      req.body.categories
    )
      ? req.body.categories
      : req.body.categories
        ? [req.body.categories]
        : [];

    /**
     * Only accept the three categories currently
     * managed by the public preference centre.
     */
    const selectedManagedIds = requested
      .map(String)
      .filter((id) =>
        MANAGED_OPTION_IDS.has(id)
      );

    /**
     * Preserve any older/unmanaged preference values
     * that may already exist in Pipedrive.
     *
     * This means removing the programme section from
     * the public page does not automatically erase
     * historical programme values when somebody saves
     * their general email preferences.
     */
    const existingIds = parseSetValue(
      person[PREFERENCES_FIELD_KEY]
    );

    const preservedIds = existingIds.filter(
      (id) =>
        !MANAGED_OPTION_IDS.has(String(id))
    );

    const allIdsToSave = [
      ...new Set([
        ...preservedIds.map(String),
        ...selectedManagedIds.map(String),
      ]),
    ];

    await updatePersonPreferences(
      person.id,
      allIdsToSave
    );

    const updatedPerson = {
      ...person,
      [PREFERENCES_FIELD_KEY]:
        allIdsToSave.join(','),
    };

    return res.send(
      renderPage({
        token,
        person: updatedPerson,
        selectedIds: allIdsToSave,
        success: true,
      })
    );
  } catch (error) {
    console.error(error);

    return res
      .status(500)
      .send(
        renderError(
          'Something went wrong while saving your preferences.'
        )
      );
  }
});

/**
 * Pipedrive webhook endpoint.
 *
 * Used for Person Create / Person Change webhooks.
 * If the Person has an email address but no preference
 * token, a new UUID token is generated automatically.
 */
app.post(
  '/webhooks/pipedrive/person',
  async (req, res) => {
    try {
      if (!isAuthorisedRequest(req)) {
        return res.status(401).json({
          ok: false,
          error: 'Unauthorized',
        });
      }

      const personId =
        extractPersonIdFromWebhook(req.body);

      const result =
        await ensurePreferenceTokenForPerson(
          personId
        );

      return res.json(result);
    } catch (error) {
      console.error(
        'Pipedrive person webhook error:',
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          'Something went wrong while processing the Pipedrive person webhook.',
      });
    }
  }
);

/**
 * Backup/safety endpoint.
 *
 * Scans Pipedrive for People with email addresses
 * who do not have an Email Preferences Token.
 *
 * Useful after bulk imports.
 *
 * Dry run:
 * /admin/fill-missing-tokens?secret=YOUR_SECRET&dryRun=true
 *
 * Create missing tokens:
 * /admin/fill-missing-tokens?secret=YOUR_SECRET
 */
app.get(
  '/admin/fill-missing-tokens',
  async (req, res) => {
    try {
      if (!isAuthorisedRequest(req)) {
        return res.status(401).json({
          ok: false,
          error: 'Unauthorized',
        });
      }

      const dryRun =
        String(
          req.query.dryRun || ''
        ).toLowerCase() === 'true';

      const maxCreatedRaw = Number(
        req.query.maxCreated || 250
      );

      const maxCreated =
        Number.isFinite(maxCreatedRaw)
          ? Math.min(
              Math.max(maxCreatedRaw, 1),
              1000
            )
          : 250;

      const result =
        await fillMissingTokens({
          dryRun,
          maxCreated,
        });

      return res.json(result);
    } catch (error) {
      console.error(
        'Fill missing tokens error:',
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          'Something went wrong while filling missing tokens.',
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(
    `Preference centre running on port ${PORT}`
  );
});