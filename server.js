require('dotenv').config();
const express = require('express');
const helmet = require('helmet');

const app = express();

app.use(helmet());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  PIPEDRIVE_API_TOKEN,
  PIPEDRIVE_COMPANY_DOMAIN,
  TOKEN_FIELD_KEY,
  PREFERENCES_FIELD_KEY,
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

/**
 * These are the Pipedrive option IDs for the client's
 * "Email Categories Subscribed To" multi-option Person field.
 */
const CATEGORY_OPTIONS = [
  { id: 505, slug: 'newsletters', label: 'Newsletters' },
  { id: 506, slug: 'product-updates', label: 'Product updates' },
  { id: 507, slug: 'events', label: 'Events' },
  { id: 508, slug: 'offers', label: 'Offers' },
  { id: 509, slug: 'case-studies', label: 'Case studies' },
];

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

async function pipedriveRequest(path, options = {}) {
  const url = new URL(`${API_BASE}${path}`);
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
    const message = body?.error || body?.error_info || response.statusText;
    throw new Error(`Pipedrive API error: ${message}`);
  }

  return body;
}

async function findPersonByToken(token) {
  const searchPath = `/persons/search?term=${encodeURIComponent(token)}&fields=custom_fields&exact_match=1&limit=10`;
  const searchResult = await pipedriveRequest(searchPath);
  const items = searchResult?.data?.items || [];

  for (const item of items) {
    const personId = item?.item?.id;
    if (!personId) continue;

    const personResult = await pipedriveRequest(`/persons/${personId}`);
    const person = personResult?.data;

    if (person && String(person[TOKEN_FIELD_KEY]) === String(token)) {
      return person;
    }
  }

  return null;
}

async function updatePersonPreferences(personId, selectedOptionIds) {
  const value = selectedOptionIds.length ? selectedOptionIds.join(',') : null;

  return pipedriveRequest(`/persons/${personId}`, {
    method: 'PUT',
    body: JSON.stringify({
      [PREFERENCES_FIELD_KEY]: value,
    }),
  });
}

function renderPage({ token, person, selectedIds = [], success = false, error = '' }) {
  const title = 'Manage your email preferences';
  const safeName = person?.name ? escapeHtml(person.name) : 'there';

  const checkboxes = CATEGORY_OPTIONS.map((option) => {
    const optionId = String(option.id);
    const checked = selectedIds.includes(optionId) ? 'checked' : '';

    return `
      <label class="option">
        <input type="checkbox" name="categories" value="${escapeHtml(optionId)}" ${checked}>
        <span>${escapeHtml(option.label)}</span>
      </label>
    `;
  }).join('');

  const successHtml = success
    ? `<div class="notice success">Your email preferences have been updated.</div>`
    : '';

  const errorHtml = error
    ? `<div class="notice error">${escapeHtml(error)}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f7f9;
      color: #1f2937;
      margin: 0;
    }

    .wrap {
      max-width: 680px;
      margin: 48px auto;
      padding: 0 20px;
    }

    .card {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 8px 30px rgba(0,0,0,.06);
    }

    h1 {
      margin: 0 0 12px;
      font-size: 30px;
      line-height: 1.15;
    }

    p {
      line-height: 1.55;
      color: #4b5563;
    }

    .option {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 0;
      border-top: 1px solid #eef0f3;
      font-size: 17px;
    }

    .option input {
      width: 20px;
      height: 20px;
    }

    .buttons {
      display: flex;
      gap: 12px;
      margin-top: 24px;
      align-items: center;
    }

    button {
      border: 0;
      border-radius: 10px;
      padding: 13px 18px;
      font-weight: 700;
      cursor: pointer;
      background: #111827;
      color: #fff;
      font-size: 16px;
    }

    .small {
      font-size: 13px;
      color: #6b7280;
      margin-top: 22px;
    }

    .notice {
      border-radius: 10px;
      padding: 12px 14px;
      margin: 18px 0;
    }

    .success {
      background: #ecfdf5;
      color: #065f46;
      border: 1px solid #a7f3d0;
    }

    .error {
      background: #fef2f2;
      color: #991b1b;
      border: 1px solid #fecaca;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <h1>${title}</h1>
      <p>Hi ${safeName}, choose which types of emails you would like to receive.</p>
      ${successHtml}
      ${errorHtml}

      <form method="post" action="/preferences">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        ${checkboxes}

        <div class="buttons">
          <button type="submit">Save preferences</button>
        </div>
      </form>

      <p class="small">To stop all marketing emails, use the unsubscribe link in the footer of the email you received.</p>
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
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Error</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f7f9;
      margin: 0;
      color: #1f2937;
    }

    .card {
      max-width: 620px;
      margin: 60px auto;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 8px 30px rgba(0,0,0,.06);
    }

    p {
      color: #4b5563;
      line-height: 1.55;
    }
  </style>
</head>
<body>
  <section class="card">
    <h1>We couldn’t open your preferences</h1>
    <p>${escapeHtml(message)}</p>
  </section>
</body>
</html>`;
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/preferences', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();

    if (!token) {
      return res.status(400).send(renderError('The preference link is missing a token.'));
    }

    const person = await findPersonByToken(token);

    if (!person) {
      return res.status(404).send(renderError('This preference link is invalid or has expired.'));
    }

    const selectedIds = parseSetValue(person[PREFERENCES_FIELD_KEY]);

    return res.send(renderPage({ token, person, selectedIds }));
  } catch (error) {
    console.error(error);
    return res.status(500).send(renderError('Something went wrong while loading your preferences.'));
  }
});

app.post('/preferences', async (req, res) => {
  try {
    const token = String(req.body.token || '').trim();

    if (!token) {
      return res.status(400).send(renderError('The preference form is missing a token.'));
    }

    const person = await findPersonByToken(token);

    if (!person) {
      return res.status(404).send(renderError('This preference link is invalid or has expired.'));
    }

    const requested = Array.isArray(req.body.categories)
      ? req.body.categories
      : req.body.categories
        ? [req.body.categories]
        : [];

    const validIds = new Set(CATEGORY_OPTIONS.map((option) => String(option.id)));
    const selectedIds = requested.map(String).filter((id) => validIds.has(id));

    await updatePersonPreferences(person.id, selectedIds);

    const updatedPerson = {
      ...person,
      [PREFERENCES_FIELD_KEY]: selectedIds.join(','),
    };

    return res.send(renderPage({
      token,
      person: updatedPerson,
      selectedIds,
      success: true,
    }));
  } catch (error) {
    console.error(error);
    return res.status(500).send(renderError('Something went wrong while saving your preferences.'));
  }
});

app.listen(PORT, () => {
  console.log(`Preference centre running on port ${PORT}`);
});