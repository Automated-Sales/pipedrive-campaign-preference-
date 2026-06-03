# Pipedrive setup checklist

## 1. Create Person fields

Go to Pipedrive > Settings > Data fields > Person.

Create:

### Email Preference Token

Recommended type: text.

This stores a unique random token per person.

### Email Categories Subscribed To

Recommended type: multiple options / set.

Example options:

- Newsletters
- Product updates
- Events
- Offers
- Case studies

## 2. Copy API keys

For each field, copy the field API key from Pipedrive and add it to `.env`:

```bash
TOKEN_FIELD_KEY=...
PREFERENCES_FIELD_KEY=...
```

Pipedrive custom field keys are account-specific, so you cannot reuse keys between Pipedrive accounts.

## 3. Get category option IDs

Fetch Person fields via the API or inspect the field options in the field definition. Add them to `.env`:

```bash
CATEGORY_OPTIONS=[{"id":12,"slug":"newsletters","label":"Newsletters"},{"id":13,"slug":"events","label":"Events"}]
```

Use option IDs, not just labels.

## 4. Generate tokens

Generate one random token per subscribed Person.

Option A: Spreadsheet method

- Export subscribed contacts from Pipedrive.
- Add a token column.
- Generate UUIDs.
- Import back into the `Email Preference Token` field.

Option B: Script/API method

- Query subscribed persons.
- For any person with a blank token, generate a UUID.
- Update the Person via API.

## 5. Add link to Pipedrive Campaign template

Add a visible link above the native unsubscribe link:

`Manage your email preferences`

The URL should be:

```text
https://preferences.clientdomain.com/preferences?token={{ Email Preference Token merge tag }}
```

Use the Campaigns merge-tag picker to insert the exact token merge tag.

## 6. Filter Campaign recipients

For each campaign type, filter recipients using:

- Marketing status = subscribed / automatically eligible for Campaigns
- Email Categories Subscribed To includes the relevant category

Example:

Newsletter campaign -> Email Categories Subscribed To includes Newsletters.

## 7. Test before going live

Test with one internal Person record first:

- Token link opens without asking for email.
- Existing preferences display correctly.
- Submit updates the Person field in Pipedrive.
- Campaign filters include/exclude the Person correctly.
