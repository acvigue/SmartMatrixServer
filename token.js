const jwt = require("jsonwebtoken");
let pk = `-----BEGIN PRIVATE KEY-----
MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgVNvyHVPaFcoglF6w
rAA+AByY+juaPXlEtBHDo7ecuY6gCgYIKoZIzj0DAQehRANCAARRHh7g6nE/79uV
HvLSaMi95qfCTX2HNcJY6IAwC5Bd1UDvpTNLu7zpgbA+Adx7rKEBjmtj5UiMmYyz
jjWKJE+V
-----END PRIVATE KEY-----`;

let token = jwt.sign({
    sub: "me.vigue.plm"
}, pk, {
    issuer: "9R8RREG67J",
    expiresIn: "10y",
    keyid: "VN8NVDG26V",
    algorithm: "ES256",
    header: {
        id: "9R8RREG67J.me.vigue.plm"
    }
})

console.log(token)