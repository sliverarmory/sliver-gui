# Cloud DNS

Open **Cloud Deployment → DNS** and choose a saved AWS or Azure account.
The first view lists that account's DNS zones. Select a zone to browse its
records, or select **All records** to browse records across all its zones.
Use **Zones** to return to the zone list. Search filters the current view;
**Refresh DNS** fetches current provider data.
The DNS tab badge counts distinct zones across all saved accounts; the zone
and record lists show the selected account. A dash means a count is unavailable.

AWS uses Route 53 hosted zones, including public and private zones. Azure uses
public DNS zones in the saved credential's subscription, across resource groups.
Switch accounts to manage another AWS account or Azure subscription. DNS access
does not require a managed deployment or an operator connection.

## Records

Use **Add record** to select a zone, name, type, TTL in seconds, and values.
The editor supports A, AAAA, CNAME, MX, TXT, NS, PTR, SRV, and CAA record sets.
Enter one value per line. A record set can contain multiple values; editing
replaces the set's TTL and values. Record names and types stay fixed when editing.
Delete asks for confirmation before removing the entire record set.

Use `@` for a zone's apex, a relative record name such as `www`, or its full
name. Values use ordinary DNS presentation format:

| Type | Example value |
| --- | --- |
| A / AAAA | `192.0.2.10` / `2001:db8::10` |
| CNAME / NS / PTR | `host.example.test.` |
| MX | `10 mail.example.test.` |
| TXT | `"example text"` |
| SRV | `10 5 443 service.example.test.` |
| CAA | `0 issue "ca.example"` |

Each TXT line is one record value and may contain multiple quoted chunks,
each at most 255 bytes. Quotes and backslashes inside a chunk must be escaped.

The UI displays provider-managed SOA and apex NS records, aliases, and records
with advanced provider settings as read-only. Their explanation appears in the
record list. Use the provider's console for those settings. Zone creation and
deletion, domain registration, and Azure Private DNS are outside this editor.

Edits and deletions check that the record still matches the version you viewed.
If it changed, refresh and review it before retrying. Changes submitted to the
provider can take time to reach DNS resolvers because of propagation and caching.
If a request's outcome cannot be confirmed, refresh before submitting it again.

## Permissions

DNS requires permissions in addition to the Cloud Deployment VM permissions.
The credential connection test and its Terraform export cover deployment
permissions; they do not establish DNS access.

For AWS, allow `route53:ListHostedZones` for account discovery and
`route53:GetHostedZone`, `route53:ListResourceRecordSets`, and
`route53:ChangeResourceRecordSets` for the hosted zones you want to manage.
For example, replace `HOSTED_ZONE_ID` with each permitted zone ID:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "route53:ListHostedZones",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "route53:GetHostedZone",
        "route53:ListResourceRecordSets",
        "route53:ChangeResourceRecordSets"
      ],
      "Resource": "arn:aws:route53:::hostedzone/HOSTED_ZONE_ID"
    }
  ]
}
```

For Azure, use **DNS Zone Contributor** on the zones or resource groups you
intend to manage, with permission to enumerate public DNS zones in the selected
subscription. A custom role can grant DNS zone reads and record-set
read/write/delete permissions. Read-only accounts can browse; provider-denied
changes are reported by the editor. The app does not change IAM or Azure role
assignments.

The all-zones view requires read access to every zone it queries. A failed zone
read produces an error rather than an apparently complete but partial list.
Use the individual zone view when an account can enumerate zones it cannot read.
Zone discovery is limited to 1,000 zones. The all-zones view handles up to 200
zones; accounts with 201–1,000 zones can use individual zone views. Each record
query is limited to 20,000 record sets.

Provider references: [Route 53 IAM policies](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/access-control-managing-permissions.html)
and [Azure DNS access control](https://learn.microsoft.com/en-us/azure/dns/dns-protect-zones-recordsets).

## Local verification

`npm run test:e2e:dns` builds and opens an isolated Electron fixture, exercises
zones, records across zones, add/edit/delete, and account switching, and writes
screenshots to `artifacts/cloud-dns/`. It uses in-memory records and never reads
cloud credentials or contacts a cloud provider. Unit tests cover provider
pagination, record conversion, stale changes, input validation, and IPC access.
