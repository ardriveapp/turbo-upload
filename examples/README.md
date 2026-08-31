# Examples

Both run against testnet, where uploads are free. Remove the `...TESTNET` spread to use production, where they are permanent and cost money.

```bash
ARWEAVE_JWK="$(cat wallet.json)" node examples/upload.js
```

| | |
|---|---|
| [`upload.js`](upload.js) | Upload bytes with tags. The common case. |
| [`sign-then-upload.js`](sign-then-upload.js) | Get the id before uploading. **Read this one before writing a retry**: signing twice produces two ids and two charges. |
