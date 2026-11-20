#!/usr/bin/env node
'use strict';

// Writes config/gitleaks.toml: Gitleaks' default rules plus LedgerLink's rules
// for blockchain private keys and BIP39 mnemonics (AI Code Review
// implementation, section 2; R22-6), npm and Yarn registry credentials and AWS
// CodeArtifact tokens (AIQC-89). The mnemonic rule is built from the BIP39
// English wordlist, which is checked against its published SHA-256 first.
//
//   npm run gen:gitleaks

const { Buffer } = require('node:buffer');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const WORDLIST = join(ROOT, 'config', 'bip39-english.txt');
const OUT = join(ROOT, 'config', 'gitleaks.toml');
// SHA-256 of english.txt in github.com/bitcoin/bips/bip-0039.
const WORDLIST_SHA256 = '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda';

const text = readFileSync(WORDLIST, 'utf8');
const actual = createHash('sha256').update(text).digest('hex');
if (actual !== WORDLIST_SHA256) {
  console.error(`config/bip39-english.txt does not match the BIP39 wordlist (sha256 ${actual})`);
  process.exit(1);
}
const words = text.split('\n').filter(Boolean);
if (words.length !== 2048) throw new Error(`expected 2048 words, got ${words.length}`);

const word = `(?:${words.join('|')})`;
// 12 to 24 consecutive wordlist words, in any letter case, separated only by
// what a written-down phrase uses: spaces and line breaks, commas, quotes and
// brackets (a string, or a pretty-printed JSON array), hyphens (joined words,
// YAML list items) and list numbers ("1. ", "2) "). Any other word breaks the
// run, so ordinary prose (which needs words like "the" or "of") rarely matches.
//
// Each way of writing a phrase has its own separator, so a run cannot mix them:
// a long JSON list of hyphenated names ("border-right", "column-gap", ...) or
// minified code is not a phrase. A JSON array counts only as a whole: 12 to 24
// one-word strings between its brackets.
const phraseForms = [
  // abandon ability able ... / abandon-ability-able-... / abandon, ability, able, ...
  String.raw`\b(?:${word}(?:\s+|-|[ \t]*,[ \t]*)){11,23}${word}\b`,
  String.raw`\[\s*(?:["'\x60]${word}["'\x60]\s*,\s*){11,23}["'\x60]${word}["'\x60]\s*\]`, // ["abandon", ...]
  // 1. abandon / 1) ABANDON. Not "45:case 47:case" (minified switch statements).
  String.raw`(?:\b\d{1,2}[.)][ \t]+${word}\s+){11,23}\d{1,2}[.)][ \t]+${word}\b`,
  String.raw`(?:-[ \t]+${word}[ \t]*\r?\n\s*){11,23}-[ \t]+${word}\b`, // - abandon (a YAML list)
];
const mnemonic = String.raw`(?i)(?:${phraseForms.join('|')})`;

// A 64-hex-digit EVM private key where only a private key goes: an ethers
// Wallet, viem's privateKeyToAccount or a Hardhat accounts list (0x optional),
// or a 0x literal assigned to a signer, pk or key name. Transaction hashes and
// keccak constants are not passed there; the entropy floor drops placeholders
// such as 0x1111... and 0xabab....
const evmCall =
  String.raw`(?i)(?:new\s+(?:ethers\s*\.\s*)?Wallet\s*\(\s*|privateKeyToAccount\s*\(\s*|accounts\s*:\s*\[[^\]]{0,400}?)` +
  String.raw`["'\x60]((?:0x)?[0-9a-f]{64})["'\x60]`;
const evmName = String.raw`(?i)\b(?:\w*signer\w*|\w*pk|key)\b["']?(?:\s*:\s*[\w.<>]+)?\s*[:=]\s*["'\x60](0x[0-9a-f]{64})["'\x60]`;

// Credentials in any file (AIQC-89). Gitleaks' default generic-api-key rule
// only matches values of 10 to 150 characters made of letters, digits, _ . = -
// (or longer base64), so it misses long tokens such as AWS CodeArtifact
// tokens, passwords with characters such as @ ! # % & ~, credentials inside
// URLs, command lines and XML, and key files. These rules look for the shape
// of a credential, not for one tool's file. Values that are references to
// somewhere else are not reported: ${VAR}, $VAR, %VAR%, {{ template }},
// <placeholder>, YAML tags, identifiers and paths, and obvious examples.

// A name that holds a credential: password, secret, token, API key, ... The
// prefix and suffix allow DB_PASSWORD, npmAuthToken, //host/:_authToken,
// "client_secret_value" and similar.
const SECRET_NAME = String.raw`[\w.-]{0,40}?(?:passw(?:or)?d|passphrase|[_.-]pass\b|pwd|secret|token|api[_.-]?key|access[_.-]?key|private[_.-]?key|signing[_.-]?key|encryption[_.-]?key|master[_.-]?key|credentials?|creds|_auth\b|authident|authorization|conn(?:ection)?[_.-]?string)[\w.-]{0,20}`;

// Values that are not credentials themselves.
const NOT_A_VALUE = [
  // A reference to an environment variable, template, YAML tag or anchor, a
  // placeholder or an expression: ${X} $X %X% {{ x }} <x> !Ref *anchor (x) [x]
  String.raw`^[$%{<(\[!&*]`,
  String.raw`\$\{|\{\{|%\(`,
  // An identifier or a dotted name without digits: process.env.DB_PASSWORD,
  // client_secret_basic, MyAppSecret.
  String.raw`^[A-Za-z_.-]{1,40}$`,
  // A URL with no user:password, or a file path.
  String.raw`^(?:https?|wss?|file)://[^@]*$`,
  String.raw`^(?:\.{0,2}/|~/|[A-Za-z]:\\)`,
  // An example: a value left out (...) or a URL whose password is the word
  // itself (https://user:password@host).
  String.raw`\.\.\.|…`,
  String.raw`(?i)://[^:/@\s]*:(?:password|passwd|pass|pwd|secret|token)@`,
  // Masked or empty-looking values.
  String.raw`^(?:\*+|x+|X+|\.+|#+|-+|0+|true|false|null|none|nil|undefined)$`,
];
const STOPWORDS = [
  'example',
  'sample',
  'dummy',
  'fake',
  'placeholder',
  'changeme',
  'change_me',
  'change-me',
  'redacted',
  'your_',
  'your-',
  'xxxx',
  'test',
  'todo',
  'insert',
  'replace',
];

// Files whose values are plain text, so an unquoted value is a literal:
// .env files, properties, ini, YAML, TOML, Terraform, shell and CI files,
// Dockerfiles, and the package managers' credential files.
const CONFIG_FILE = String.raw`(?i)(?:^|/)(?:\.env(?:\.[\w.-]+)?|[\w.-]*\.(?:env|properties|ini|cfg|conf|config|toml|ya?ml|tfvars|hcl|sh|bash|zsh|ksh|ps1|psm1|bat|cmd)|\.npmrc|\.yarnrc|\.pypirc|\.gemrc|\.s3cfg|\.boto|credentials|pip\.(?:conf|ini)|gradle\.properties|[\w.-]*dockerfile|containerfile|makefile|jenkinsfile|procfile)$`;

const tomlList = (xs) => `[${xs.map((x) => `'''${x}'''`).join(', ')}]`;
const notAValue = String.raw`
[[rules.allowlists]]
description = "References to a value kept elsewhere, identifiers, paths and examples"
regexTarget = "secret"
regexes = ${tomlList(NOT_A_VALUE)}

[[rules.allowlists]]
stopwords = ${JSON.stringify(STOPWORDS)}
`;

// A password inside a URL is never a code identifier, so the identifier
// exclusion does not apply: postgres://app:SuperSecretPassword@db is reported.
// Only the words written as placeholders are not.
const IDENTIFIER = String.raw`^[A-Za-z_.-]{1,40}$`;
if (!NOT_A_VALUE.includes(IDENTIFIER)) throw new Error('the identifier exclusion changed; update NOT_A_URL_PASSWORD');
const NOT_A_URL_PASSWORD = [
  ...NOT_A_VALUE.filter((r) => r !== IDENTIFIER),
  String.raw`(?i)^(?:password|passw0rd|passwd|pass|pwd|pw|secret|token|changeme|username|user)$`,
];
const notAUrlPassword = String.raw`
[[rules.allowlists]]
description = "References to a value kept elsewhere, placeholder words, paths and examples"
regexTarget = "secret"
regexes = ${tomlList(NOT_A_URL_PASSWORD)}

[[rules.allowlists]]
stopwords = ${JSON.stringify(STOPWORDS)}
`;

const CREDENTIAL_RULES = String.raw`[[allowlists]]
description = "Template placeholders ({{NAME}}, {{ .Values.x }}, {{ secrets.X }}) are never the credential, for any rule"
regexTarget = "match"
regexes = ['''\{\{[^{}\n]{1,100}\}\}''']

[[rules]]
id = "credential-assignment"
description = "Credential assigned to a password, secret, token or key name, in any file"
# An optional type between the name and the value: "token: string =" (TypeScript,
# Kotlin, Swift; "token?: string =" for an optional property), "API_TOKEN: &str ="
# (Rust), "token string =" (Go). A quoted name ("password": "...") has no type,
# so HTML such as <img src="1password-icon.svg" alt="..."> is not a match.
regex = '''(?i)${SECRET_NAME}(?:["'\x60]|\??[ \t]*:[ \t]*&?[\w.<>\[\]?]{1,40}|[ \t]+[\w.\[\]*]{1,30})?[ \t]*(?::=|=>|\?=|[:=])[ \t]*["'\x60]([^\s"'\x60]{8,})["'\x60]'''
secretGroup = 1
entropy = 2.5
tags = ["credential"]
${notAValue}
[[rules]]
id = "credential-assignment-config"
description = "Credential assigned to a password, secret, token or key name, unquoted, in a configuration, environment, shell or CI file"
path = '''${CONFIG_FILE}'''
regex = '''(?i)${SECRET_NAME}[ \t]*(?::=|[:=])[ \t]*([^\s"'\x60#;][^\s"'\x60]{6,}[^\s"'\x60),;\]}])'''
secretGroup = 1
entropy = 2.5
tags = ["credential"]
${notAValue}
[[rules]]
id = "credential-export"
description = "Credential set as an environment variable on a shell or Dockerfile line, unquoted, in any file (export TOKEN=..., set, ENV, ARG)"
regex = '''(?i)(?:^|[\s;&|\x60(])(?:export|set|env|arg)\s+${SECRET_NAME}[ \t]*=[ \t]*([^\s"'\x60#;][^\s"'\x60]{6,}[^\s"'\x60),;\]}])'''
secretGroup = 1
entropy = 2.5
tags = ["credential"]
${notAValue}
[[rules]]
id = "credential-in-connection-string"
description = "Password in a connection string or URL query (Password=...; ?password=...&, ?access_token=, ?sig=)"
# A "#" inside the value is part of the password (Password=abc#def;), not a comment.
regex = '''(?i)(?:^|[;"'\s?&])(?:password|passwd|pwd|access_token|api[_-]?key|client_secret|sig)=([^;&\s"'\x60#<>][^;&\s"'\x60<>]{4,}[^;&\s"'\x60<>),\]}])'''
secretGroup = 1
entropy = 2.5
tags = ["credential"]
${notAValue}
[[rules]]
id = "credential-in-url"
description = "User name and password inside a URL (https://user:password@host, postgres://, amqp://, git remotes, registry URLs)"
regex = '''(?i)\b[a-z][a-z0-9+.-]{1,30}://[^\s:@/'"\x60<>{}$]{1,128}:([^\s@/'"\x60<>{}$]{3,256})@[a-z0-9][a-z0-9.-]*'''
secretGroup = 1
tags = ["credential", "url"]

[[rules.allowlists]]
description = "Local development hosts, and the domains reserved for documentation (RFC 2606)"
regexTarget = "match"
regexes = [
  '''@(?:localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)\b''',
  '''(?i)@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|[\w-]+\.(?:example|test|invalid|localhost))\b''',
]
${notAUrlPassword}
[[rules]]
id = "credential-on-command-line"
description = "Credential given on a command line (--password, --token, --api-key, --secret, curl -u user:password)"
regex = '''(?i)(?:^|[\s"'])(?:--(?:password|passwd|token|auth-token|access-token|api-key|apikey|secret|client-secret|secret-key|access-key|private-key)(?:=|\s+)|(?:-u|--user)\s+["']?[^\s:"'$]{1,128}:)["']?([^\s"'\x60]{5,}[^\s"'\x60),;\]}])'''
secretGroup = 1
entropy = 2.5
tags = ["credential", "command-line"]
${notAValue}
[[rules]]
id = "credential-authorization-header"
description = "Authorization header with a credential (Bearer, Basic, Token)"
regex = '''(?i)\bauthorization["']?[ \t]*[:=][ \t]*["']?(?:bearer|basic|token|apikey)\s+([a-z0-9._~+/=-]{16,})'''
secretGroup = 1
entropy = 3.0
tags = ["credential", "http"]
${notAValue}
[[rules]]
id = "credential-in-xml"
description = "Credential in an XML element: <password>...</password> (Maven settings.xml and similar)"
regex = '''(?i)<(?:password|passphrase|secret|token|apiKey|api-key|privateKey|clientSecret)>[ \t]*([^<\s]{6,})[ \t]*</'''
secretGroup = 1
tags = ["credential", "xml"]
${notAValue}
[[rules]]
id = "credential-in-xml-setting"
description = "Credential in an XML setting: <add key=\"...Password\" value=\"...\"/> (NuGet.Config, app.config, web.config)"
regex = '''(?i)<add\s+key=["'][^"']*(?:password|secret|token|apikey)[^"']*["']\s+value=["']([^"']{6,})["']'''
secretGroup = 1
tags = ["credential", "xml"]
${notAValue}
[[rules]]
id = "netrc-password"
description = "Password in a .netrc or _netrc file"
path = '''(?i)(?:^|/)[._]netrc$'''
regex = '''(?i)\bpassword\s+(\S{4,})'''
secretGroup = 1
tags = ["credential"]

[[rules]]
id = "credential-file"
description = "A file that holds credentials by nature: SSH private key, .git-credentials, .pgpass, keystore (.p12, .pfx, .jks, .keystore, .ppk, .kdbx)"
path = '''(?i)(?:^|/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.git-credentials|\.pgpass|[\w.-]+\.(?:p12|pfx|jks|keystore|ppk|kdbx))$'''
tags = ["credential", "file"]

[[rules]]
id = "jwe-token"
description = "Encrypted token in JWE compact form (five dot-separated parts), such as an AWS CodeArtifact token"
regex = '''\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{10,})'''
secretGroup = 1
keywords = ["eyj"]
tags = ["credential", "jwe"]

[[rules]]
id = "aws-codeartifact-token"
description = "AWS CodeArtifact authorization token"
# The token is a JWE whose header always starts {"ver":1,"isu":... (AIQC-89).
regex = '''\b(eyJ2ZXIiOjEsImlzdSI6[A-Za-z0-9_.\-]{100,})'''
secretGroup = 1
keywords = ["eyj2zxiiojesimlzdsi6"]
tags = ["aws", "codeartifact", "credential"]
`;

const toml = `# Gitleaks configuration for the secrets.gitleaks check (pre-commit and CI).
# GENERATED by scripts/gen-gitleaks-config.js: edit the script, then run
# "npm run gen:gitleaks". Do not edit this file by hand.
#
# Gitleaks' default rules, plus LedgerLink's rules for blockchain private keys
# and BIP39 mnemonics (AI Code Review implementation, section 2; R22-6), npm
# and Yarn registry credentials and AWS CodeArtifact tokens (AIQC-89).
title = "LedgerLink qa"

[extend]
useDefault = true

[[rules]]
id = "evm-private-key"
description = "EVM private key (64 hex characters) assigned to a key-like name"
regex = '''(?i)(?:priv(?:ate)?|secret|signer|signing|wallet|deployer|owner|operator)[_.\\- ]?key["']?\\s*[:=]\\s*["'\`]?(?:0x)?([0-9a-f]{64})\\b'''
secretGroup = 1
entropy = 3.0
keywords = ["key"]
tags = ["blockchain", "private-key"]

[[rules]]
id = "evm-private-key-call"
description = "EVM private key (64 hex characters) passed to a wallet, an account or an accounts list"
regex = '''${evmCall}'''
secretGroup = 1
entropy = 3.2
keywords = ["wallet", "privatekeytoaccount", "accounts"]
tags = ["blockchain", "private-key"]

[[rules]]
id = "evm-private-key-name"
description = "EVM private key (0x and 64 hex characters) assigned to a signer, pk or key name"
regex = '''${evmName}'''
secretGroup = 1
entropy = 3.2
keywords = ["0x"]
tags = ["blockchain", "private-key"]

[[rules]]
id = "bip32-extended-private-key"
description = "BIP32 extended private key (xprv, tprv, yprv, zprv)"
regex = '''\\b([xtyzuv]prv[1-9A-HJ-NP-Za-km-z]{107,108})\\b'''
secretGroup = 1
keywords = ["prv"]
tags = ["blockchain", "private-key"]

[[rules]]
id = "bitcoin-wif-private-key"
description = "Bitcoin private key in Wallet Import Format"
regex = '''\\b([5KLc9][1-9A-HJ-NP-Za-km-z]{50,51})\\b'''
secretGroup = 1
entropy = 4.5
tags = ["blockchain", "private-key"]

[[rules]]
id = "solana-keypair-array"
description = "Solana keypair: a JSON array of 64 byte values"
regex = '''\\[\\s*(?:\\d{1,3}\\s*,\\s*){63}\\d{1,3}\\s*\\]'''
tags = ["blockchain", "private-key"]

${CREDENTIAL_RULES}
[[rules]]
id = "bip39-mnemonic"
description = "BIP39 recovery phrase: 12 to 24 consecutive words from the BIP39 English wordlist"
regex = '''${mnemonic}'''
tags = ["blockchain", "mnemonic"]

[[rules.allowlists]]
description = "The BIP39 wordlist this rule is generated from"
paths = ['''(?:^|/)bip39-english\\.txt$''']
`;

writeFileSync(OUT, toml);
console.log(`Wrote ${OUT} (${words.length}-word BIP39 rule, ${Buffer.byteLength(toml)} bytes)`);
