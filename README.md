# Pipedrive Campaigns Preference Centre

A small Express app that lets Pipedrive Campaigns recipients manage email category preferences without typing their email address.

The flow is:

1. Each Pipedrive Person has a random token stored in a custom Person field.
2. Pipedrive Campaigns includes a personalised link such as:
   `https://preferences.yourclientdomain.com/preferences?token={{person.Email Preference Token}}`
3. The page finds the Person in Pipedrive by token.
4. It displays the Person's current category preferences.
5. On submit, it updates a Pipedrive multi-option Person field.

## Pipedrive fields needed

Create two Person custom fields:

1. `Email Preference Token`
   - Type: text
   - API key goes into `TOKEN_FIELD_KEY`

2. `Email Categories Subscribed To`
   - Type: multiple options / set
   - Example options: Newsletters, Product updates, Events, Offers
   - API key goes into `PREFERENCES_FIELD_KEY`
   - Option IDs go into `CATEGORY_OPTIONS`

Pipedrive custom field API keys are account-specific 40-character hashes, so you must copy them from the client account.

## Install

```bash
npm install
cp .env.example .env
npm run dev
```

## Required .env values

```bash
PIPEDRIVE_API_TOKEN=...
PIPEDRIVE_COMPANY_DOMAIN=clientcompany
TOKEN_FIELD_KEY=...
PREFERENCES_FIELD_KEY=...
CATEGORY_OPTIONS=[{"id":1,"slug":"newsletters","label":"Newsletters"}]
```

## Routes

### `GET /preferences?token=abc123`

Shows the preference form for the matching Pipedrive Person.

### `POST /preferences`

Updates the Pipedrive Person's preference field.

### `GET /health`

Simple health check.

## Generating tokens

For an individual token:

```bash
npm run generate-token
```

For a bulk rollout, export subscribed people from Pipedrive, generate one token per Person, then import the tokens back into the `Email Preference Token` field. Alternatively, write a short script to update the field via the Pipedrive API.

## Campaign link

In Pipedrive Campaigns, add a link above the standard unsubscribe link:

`https://preferences.yourclientdomain.com/preferences?token={{ person.Email Preference Token }}`

The exact merge tag syntax should be selected from the Pipedrive Campaign editor's merge tag picker, because field names vary by account.

## Important notes

- Keep Pipedrive's native unsubscribe link in the footer. This app manages category preferences only.
- If a recipient clicks Pipedrive's native unsubscribe link, they are globally unsubscribed from Campaigns.
- Use a random token, not email address or Person ID.
- If someone forwards an email, the forwarded recipient could use the preference link. This is a normal magic-link trade-off.
- Test field update behaviour in a sandbox/person record before using with live contacts.
