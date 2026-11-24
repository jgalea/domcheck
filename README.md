<h1 align="center">domcheck</h1>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/LICENSE-MIT-5C9E31?style=for-the-badge"></a>
  <a href="https://github.com/jgalea"><img alt="Built by" src="https://img.shields.io/badge/BUILT%20BY-JEAN%20GALEA-8A2BE2?style=for-the-badge"></a>
</p>

<p align="center"><b>Check hundreds of domain names at once, free, straight from the registries.</b></p>

domcheck asks each registry's RDAP service whether a domain is registered. RDAP is the public lookup protocol every gTLD registry runs, so there's no API key, no account and no registrar in the middle. The list of RDAP servers comes from IANA and is cached for a day. Country TLDs without RDAP, like .io, go to the registry's whois server instead, which needs the `whois` command (standard on macOS and Linux).

## Install

Needs Node 20 or later. No dependencies.

```sh
git clone https://github.com/jgalea/domcheck
ln -s "$PWD/domcheck/domcheck.mjs" ~/.local/bin/domcheck
```

## Use

```sh
domcheck acme northwind -t com,app,io       # bare names against each TLD
domcheck example.org example.dev            # full domains
domcheck -f names.txt -t com,app -a         # from a file, only the available ones
cat names.txt | domcheck -t app --json      # from stdin, as JSON
```

```
taken     acme.com
available northwind.app
unknown   acme.so        no RDAP server for .so
```

| Option | What it does |
|---|---|
| `-t, --tlds` | TLDs for bare names, comma separated (default `com`) |
| `-f, --file` | Names or domains, one per line, `#` for comments |
| `-c, --concurrency` | Requests in flight per registry (default 2) |
| `-a, --available` | Print only available domains |
| `--json` | JSON output |
| `--no-verify` | Skip the per-TLD control check |
| `--refresh` | Re-download the IANA server list |

Before checking your names, domcheck looks up a random unregistered name in each TLD and expects the registry to say it's free. A TLD whose registry answers anything else is reported as `unknown` instead of trusted. Rate limits (HTTP 429) and server errors are retried with backoff, and requests are spaced out per registry.

`available` means the registry has no record of the domain. Registries hold back some reserved and premium names, so a registrar can still refuse one or charge more for it. A whois reply only counts when it clearly says the name is free or shows a registration record. Anything else, such as a rate-limit message, comes back as `unknown`.

The exit code is 0 when every domain got a definite answer and 1 when any came back `unknown`.

## License

MIT
