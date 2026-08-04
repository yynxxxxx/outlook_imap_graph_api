"""
Proton Mail 注册脚本（纯协议实现）
=====================================
依赖：
    pip install curl_cffi bcrypt pgpy

两种模式：
  1. 注册模式（默认）：python proton_register.py
     交互流程（按 API 文档顺序）：
       1. 输入用户名 / 密码 / 外部邮箱
       2. 脚本自动：
           ① 检查用户名可用性
           ② 获取 SRP 模数
           ③ 生成 SRP Salt + Verifier
           ④ 首次 POST /users → 预期 422 + HV Token
           ⑤ POST /users/code → 发送验证码到你的邮箱
       3. ★ 暂停，等你在终端输入收到的验证码 ★
       4. 脚本自动：
           ⑥ 携带验证码二次 POST /users → 账号创建成功
           ⑦ auth/info + auth → SRP 登录建立会话
           ⑧ 获取地址列表
           ⑨ 生成 PGP 密钥并上传 /keys/setup
           ⑩ 设置语言 + 保存本地会话密钥

  2. 取件模式：python proton_register.py --mail（或 -m）
     登录既有账号 → 收件箱列表 → 逐封打印单封详情 → 地址私钥 PGP 解密正文。

  3. 恢复邮箱模式：python proton_register.py --recovery-email（或 -r）
     登录既有账号 → 解锁 password scope → 写入恢复邮箱 → 发送并确认验证码。
"""

import base64
import hashlib
import json
import os
import secrets
import string
import subprocess
import sys

import bcrypt

try:
    # Windows 终端默认 GBK 时无法输出脚本里的 Unicode 状态符号。
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    from curl_cffi import requests as cffi_requests
    from curl_cffi.requests import Session
except ImportError:
    print("[错误] 未安装 curl_cffi，请执行：pip install curl_cffi")
    sys.exit(1)

try:
    import pgpy
    from pgpy import PGPKey, PGPUID
    from pgpy.constants import (
        CompressionAlgorithm,
        EllipticCurveOID,
        HashAlgorithm,
        KeyFlags,
        PubKeyAlgorithm,
        SymmetricKeyAlgorithm,
    )
except ImportError:
    print("[错误] 未安装 pgpy，请执行：pip install pgpy")
    sys.exit(1)


# ─────────────────────────────────────────────────
#  常量 & 配置
# ─────────────────────────────────────────────────

BASE_URL = "https://account.proton.me"
APP_VERSION = "web-account@5.0.403.0"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/150.0.0.0 Safari/537.36"
)

PROTON_PROXY_URL = os.environ.get("PROTON_PROXY_URL", "").strip()

# SRP-6a 参数
SRP_LEN_BYTES = 256  # 2048-bit
SALT_LEN_BYTES = 10
PM_SRP_VERSION = 4
PROTON_PRIMARY_KEY_UID = "not_for_email_use@domain.tld"
PROTON_SKL_CONTEXT_NAME = "context@proton.ch"
PROTON_SKL_CONTEXT_VALUE = "key-transparency.key-list"
OPENPGPJS_SALT_NOTATION = "salt@notations.openpgpjs.org"

# SRP 生成元固定为 2
G_HEX = b"2"


# ─────────────────────────────────────────────────
#  内联 Proton SRP-6a 实现
#  移植自 ProtonMail/proton-python-client
# ─────────────────────────────────────────────────

class PMHash:
    """
    Proton 定制哈希（expandHash）：4 路 SHA512 拼接，每路在数据尾部追加一个索引字节，输出 256 字节。
    与官方 pm-srp（ProtonMail/pm-srp/lib/passwords.js）完全一致：
        expandHash(input) = SHA512(input || 0) || SHA512(input || 1) || SHA512(input || 2) || SHA512(input || 3)
    注意：索引字节必须追加在「尾部」，而不是前缀在头部。方向反了会导致注册时
    服务端存储的 Verifier 与登录时客户端计算的 ClientProof 派生出不同的 x，登录必然报
    Code=8002 / WrongPassword。
    """
    digest_size = 256
    name = "PMHash"

    def __init__(self, b: bytes = b""):
        self.b = b

    def update(self, b: bytes):
        self.b += b

    def digest(self) -> bytes:
        # 4 段拼接：H(data||0), H(data||1), H(data||2), H(data||3)
        return b"".join(
            hashlib.sha512(self.b + bytes([i])).digest()
            for i in range(4)
        )


def _bcrypt_b64_encode(s: bytes) -> bytes:
    """将标准 Base64 字符映射成 bcrypt 所用的 Base64 字符表"""
    bcrypt_b64 = b"./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    std_b64 = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    return base64.b64encode(s).translate(bytes.maketrans(std_b64, bcrypt_b64))


def _hash_password_v4(password: bytes, salt: bytes, modulus: bytes) -> bytes:
    """
    Proton SRP 版本 4 的密码哈希：
    1. salt = (salt + b"proton")[:16]
    2. bcrypt_salt = bcrypt_b64(salt)[:22]
    3. hashed = bcrypt(password, $2y$10$ + bcrypt_salt)
    4. return PMHash(hashed + modulus).digest()
    """
    bsalt = (salt + b"proton")[:16]
    bsalt = _bcrypt_b64_encode(bsalt)[:22]
    hashed = bcrypt.hashpw(password, b"$2y$10$" + bsalt)
    return PMHash(hashed + modulus).digest()


def derive_key_password(password: str, key_salt_b64: str) -> str:
    """
    派生 Proton 私钥加密口令。

    Proton WebClients 的密钥流程使用 computeKeyPassword(password, KeySalt)，
    再把派生结果交给 OpenPGP encryptPrivateKey/importPrivateKey。这里复现
    pm-srp 的 bcrypt 口令派生：bcrypt 输出去掉 "$2y$10$<22字节盐>" 前缀后，
    剩余部分才是真正的私钥 passphrase。
    """
    key_salt = base64.b64decode(key_salt_b64)
    bsalt = _bcrypt_b64_encode(key_salt)[:22]
    hashed = bcrypt.hashpw(password.encode("utf-8"), b"$2y$10$" + bsalt)
    return hashed[29:].decode("ascii")


def openpgpjs_salt_notation() -> bytearray:
    """生成 openpgp.js detached signature 默认携带的随机 salt notation。"""
    return bytearray(os.urandom(32))


def run_openpgp_helper(payload: dict) -> dict:
    """调用本地 openpgp.js helper，生成与 Proton Web 更一致的密钥和签名 packet。"""
    helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proton_openpgp_helper.js")
    if not os.path.exists(helper):
        raise RuntimeError(f"缺少 openpgp.js helper：{helper}")
    proc = subprocess.run(
        ["node", helper],
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"openpgp.js helper 执行失败：{proc.stderr.strip() or proc.stdout[:300]}")
    try:
        return json.loads(proc.stdout)
    except Exception as e:
        raise RuntimeError(f"openpgp.js helper 返回非 JSON：{proc.stdout[:300]}") from e


def _bytes_to_long(b: bytes) -> int:
    return int.from_bytes(b, "little")


def _long_to_bytes(n: int, num_bytes: int) -> bytes:
    return n.to_bytes(num_bytes, "little")


def _get_random_of_length(n_bytes: int) -> int:
    """生成高位为 1 的随机大整数（保证长度稳定）"""
    offset = n_bytes * 8 - 1
    return _bytes_to_long(os.urandom(n_bytes)) | (1 << offset)


def _hash_k(g: int, modulus: int, width: int) -> int:
    """SRP-6a 乘数：k = H(N_le || g_le)，小端序填充至 width 字节"""
    h = PMHash()
    h.update(g.to_bytes(width, "little"))
    h.update(modulus.to_bytes(width, "little"))
    return _bytes_to_long(h.digest())


def _custom_hash(*args) -> int:
    """对多个参数拼接后计算 PMHash，整数参数自动转小端序 SRP_LEN_BYTES 字节"""
    h = PMHash()
    for s in args:
        if s is not None:
            data = _long_to_bytes(s, SRP_LEN_BYTES) if isinstance(s, int) else s
            h.update(data)
    return _bytes_to_long(h.digest())


def _extract_modulus_from_pgp(modulus_block: str) -> bytes:
    """
    从 PGP 签名消息中提取 Base64 裸模数。
    Proton 返回的格式：
      -----BEGIN PGP SIGNED MESSAGE-----
      Hash: SHA256

      <Base64 模数>
      -----BEGIN PGP SIGNATURE-----
      ...
    """
    lines = modulus_block.strip().splitlines()
    in_body = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("Hash:"):
            in_body = True
            continue
        if in_body and stripped and not stripped.startswith("-----"):
            return base64.b64decode(stripped)
    raise ValueError("无法从 PGP 签名消息中提取 Modulus")


class ProtonSRPUser:
    """
    Proton SRP-6a 客户端实现。
    - 注册时调用 generate_verifier() 生成 Verifier
    - 登录时调用 process_challenge() 生成 ClientProof
    """

    def __init__(self, password: str, modulus_bin: bytes):
        self.password_bytes = password.encode("utf-8")
        self.modulus_bin = modulus_bin

        # N: SRP 模数（来自服务端 PGP 签名消息，小端序）
        self.N = _bytes_to_long(modulus_bin)
        # g: 生成元固定为 2
        self.g = 2
        # k: SRP-6a 乘数 = H(N || g)
        self.k = _hash_k(self.g, self.N, SRP_LEN_BYTES)

        # 客户端私有临时值 a（随机 32 字节）
        self.a = _get_random_of_length(32)
        # 客户端公开临时值 A = g^a mod N
        self.A = pow(self.g, self.a, self.N)

    def get_client_ephemeral_b64(self) -> str:
        """返回 Base64 编码的客户端临时公钥 A（小端序 256 字节）"""
        return base64.b64encode(_long_to_bytes(self.A, SRP_LEN_BYTES)).decode()

    def generate_verifier(self, salt: bytes) -> bytes:
        """
        SRP 注册阶段：生成密码验证子
        x = H(password, salt, N)
        v = g^x mod N
        返回 256 字节小端序
        """
        x = _bytes_to_long(
            _hash_password_v4(self.password_bytes, salt, self.modulus_bin)
        )
        v = pow(self.g, x, self.N)
        return _long_to_bytes(v, SRP_LEN_BYTES)

    def process_challenge(self, salt: bytes, server_ephemeral_b64: str):
        """
        SRP 登录第二阶段：处理服务端临时公钥 B，计算 ClientProof M1
        返回：(client_proof_b64, session_key_bytes)
        """
        B_bin = base64.b64decode(server_ephemeral_b64)
        B = _bytes_to_long(B_bin)

        if B % self.N == 0:
            raise ValueError("服务端临时公钥 B 无效（B mod N == 0）")

        # 随机扰乱参数 u = H(A || B)
        u = _custom_hash(self.A, B)
        if u == 0:
            raise ValueError("SRP 扰乱参数 u 为 0，请重试")

        # 私有密钥 x = H(password, salt, N)
        x = _bytes_to_long(
            _hash_password_v4(self.password_bytes, salt, self.modulus_bin)
        )

        # 预主密钥 S = (B - k*g^x)^(a + u*x) mod N
        k_gx = (self.k * pow(self.g, x, self.N)) % self.N
        base_val = (B - k_gx) % self.N
        exp = (self.a + u * x) % (self.N - 1)
        S = pow(base_val, exp, self.N)

        # 会话密钥 K = S 的字节表示
        K = _long_to_bytes(S, SRP_LEN_BYTES)

        # 客户端证明 M1 = H(A || B || K)
        h_m1 = PMHash()
        h_m1.update(_long_to_bytes(self.A, SRP_LEN_BYTES))
        h_m1.update(_long_to_bytes(B, SRP_LEN_BYTES))
        h_m1.update(K)
        M1 = h_m1.digest()

        return base64.b64encode(M1).decode(), K


# ─────────────────────────────────────────────────
#  PGP 密钥生成（用于 /keys/setup）
# ─────────────────────────────────────────────────

def proton_sha256_fingerprints(pgp_key) -> list:
    """
    复现 Proton 官方 getSHA256Fingerprints（pmcrypto lib/key/utils.js）：
        对主密钥与每个子密钥的【公钥 packet】逐个计算 SHA256，
        顺序 = key.getKeys() = 主公钥在前，子密钥依次在后。
    v4 密钥：SHA256(packet_header + packet_body)
        - packet_header = 0x99 0x00 <body_len>（v4 旧格式两字节长度编码）
        - packet_body   = pubkey.hashdata（不含 header 的包体）
    已用 HAR 中真实密钥验证：与 openpgp.js 的 keyPacket.writeForHash(4) 完全一致，
    且哈希结果与服务端校验值逐位匹配。
    """
    import hashlib as _hashlib
    fps = []
    pub_parts = [pgp_key.pubkey]
    for sk in pgp_key.subkeys.values():
        pub_parts.append(sk.pubkey)
    for pub in pub_parts:
        body = bytes(pub.hashdata)
        # v4 公钥包 header: 0x99(tag) + 0x00(两字节长度格式) + 长度
        header = bytes([0x99, 0x00, len(body)])
        fps.append(_hashlib.sha256(header + body).hexdigest())
    return fps


def generate_keys_for_proton(username: str, password: str) -> dict:
    """
    为 Proton 账号生成 PGP 密钥体系（Curve25519）：
    - 主密钥（PrimaryKey）：用密码口令保护
    - 地址密钥（AddressKey）：用随机地址 token 保护
    - SignedKeyList：地址密钥自签名
    - Token：主公钥加密的随机令牌（用于服务端密钥授权）

    返回 dict，包含所有上传 /keys/setup 所需的字段
    """
    email = f"{username}@proton.me"

    # 生成 KeySalt，并按 Proton Web 同款 KDF 派生 OpenPGP 私钥口令
    key_salt_bytes = os.urandom(16)
    key_salt_b64 = base64.b64encode(key_salt_bytes).decode()
    key_password = derive_key_password(password, key_salt_b64)
    address_token = base64.b64encode(os.urandom(48)).decode()

    generated = run_openpgp_helper({
        "command": "generate",
        "email": email,
        "key_password": key_password,
        "address_token": address_token,
    })
    primary_key_armored = generated["primary_private"]
    address_key_armored = generated["address_private"]

    # ── 指纹 & SHA256 指纹 ──
    fp_hex = generated["address_fingerprint"].lower()
    sha256_fps = generated["address_sha256_fingerprints"]

    # ── SignedKeyList（地址密钥自签名）──
    skl_data = json.dumps([{
        "Primary": 1,
        "Flags": 3,
        "Fingerprint": fp_hex,
        "SHA256Fingerprints": sha256_fps,
    }], separators=(",", ":"))

    # ── Token（主公钥加密的地址密钥口令）──
    # Proton 官方 encryptAddressKeyToken 要求：
    #   1. 地址私钥本身用 address_token 保护
    #   2. 用主公钥加密 address_token 明文 → Token 字段
    #   3. 用主私钥对 address_token 明文做 detached 签名 → AddressKeys[i].Signature 字段
    # 若只加密不签名，keys/setup 会因缺少 Signature 字段或签名不匹配失败。
    finalized = run_openpgp_helper({
        "command": "finalize",
        "primary_private": primary_key_armored,
        "address_private": address_key_armored,
        "key_password": key_password,
        "address_token": address_token,
        "skl_data": skl_data,
        "token_plaintext": address_token,
    })
    skl_signature = finalized["skl_signature"]
    token_armored = finalized["token_armored"]
    token_signature_armored = finalized["token_signature"]

    return {
        "key_salt": key_salt_b64,
        "primary_key_armored": primary_key_armored,
        "address_key_armored": address_key_armored,
        "fingerprint": fp_hex,
        "skl_data": skl_data,
        "skl_signature": skl_signature,
        "token_armored": token_armored,
        "token_signature_armored": token_signature_armored,
    }


# ─────────────────────────────────────────────────
#  HTTP 会话封装
# ─────────────────────────────────────────────────

def build_session(log_proxy: bool = True) -> Session:
    """创建模拟 Chrome 浏览器指纹的 curl_cffi 会话，并按需挂载代理"""
    sess = Session(impersonate="chrome120")
    sess.headers.update({
        "Accept": "application/vnd.protonmail.v1+json",
        "Content-Type": "application/json",
        "Origin": "https://account.proton.me",
        "Referer": "https://account.proton.me/start?ref=pme_hp_b2c-1",
        "X-Pm-Appversion": APP_VERSION,
        "X-Pm-Locale": "zh_CN",
        "X-Pm-Product": "generic",
        "User-Agent": USER_AGENT,
    })
    if PROTON_PROXY_URL:
        sess.proxies = {
            "http": PROTON_PROXY_URL,
            "https": PROTON_PROXY_URL,
        }
        if log_proxy:
            print("  [代理] 已启用 PROTON_PROXY_URL 代理")
    return sess


def init_guest_session(sess: Session) -> None:
    """
    步骤 0（前置）：获取匿名 Guest Session。

    Proton 现在要求所有 API 调用（包括注册流程）都需要先通过
    POST /api/auth/v4/sessions 建立匿名会话，拿到 AccessToken 和 UID，
    然后在后续请求中携带：
      Authorization: Bearer <AccessToken>
      X-Pm-Uid: <UID>
    否则返回 HTTP 401 "无效的访问令牌"。
    """
    url = BASE_URL + "/api/auth/v4/sessions"
    # 匿名 session 请求体为空 JSON 对象
    resp = sess.post(url, json={})
    print(f"  [POST] /api/auth/v4/sessions  → HTTP {resp.status_code}")
    try:
        data = resp.json()
    except Exception:
        raise RuntimeError(f"获取 Guest Session 失败（非 JSON 响应）：{resp.text[:200]}")

    if resp.status_code not in (200, 201) or data.get("Code") not in (1000, None):
        # 某些版本成功时 Code 字段可能不存在，以 HTTP 状态码为准
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"获取 Guest Session 失败（HTTP {resp.status_code}）：{data}")

    access_token = data.get("AccessToken") or data.get("access_token", "")
    uid = data.get("UID") or data.get("uid", "")

    if not access_token:
        raise RuntimeError(f"Guest Session 响应中未找到 AccessToken：{data}")

    # 将 Bearer token 和 UID 注入会话默认头，后续所有请求自动携带
    sess.headers.update({
        "Authorization": f"Bearer {access_token}",
        "X-Pm-Uid": uid,
    })
    print(f"  ✓ Guest Session 建立成功，UID = {uid[:16]}...")


def api_get(
    sess: Session,
    path: str,
    params: dict | None = None,
    log_path: str | None = None,
) -> dict:
    """GET 请求封装，返回响应 JSON"""
    url = BASE_URL + path
    resp = sess.get(url, params=params)
    print(f"  [GET]  {log_path or path}  → HTTP {resp.status_code}")
    try:
        return resp.json()
    except Exception:
        return {"_raw": resp.text, "_status": resp.status_code}


def api_post(
    sess: Session,
    path: str,
    body: dict,
    extra_headers: dict | None = None,
    log_path: str | None = None,
) -> dict:
    """POST 请求封装，返回响应 JSON"""
    url = BASE_URL + path
    headers = {}
    if extra_headers:
        headers.update(extra_headers)
    resp = sess.post(url, json=body, headers=headers)
    print(f"  [POST] {log_path or path}  → HTTP {resp.status_code}")
    try:
        data = resp.json()
    except Exception:
        return {"_raw": resp.text, "_status": resp.status_code}
    if path == "/api/core/v4/auth" and data.get("Code") == 1000:
        # ── 捕获用户会话令牌（取件/续期凭证）──
        # 实测（2026-08-02）：
        #   - 直接 POST /auth 时，AccessToken/RefreshToken 在【响应体】里返回，
        #     ExpiresIn=86400（24 小时），Scopes 含 full/mail 等取件所需范围。
        #   - 浏览器 WebApp 场景则通过 Set-Cookie: AUTH-<uid> / REFRESH-<uid> 下发。
        #     Cookie 可持久化很久（HAR 中 Max-Age=31536000），但这不是 AccessToken
        #     的服务端有效期；AccessToken 仍以 ExpiresIn 为准，过期后走 refresh。
        #   两者是同一套令牌体系的不同传输方式，优先响应体，cookie 兜底。
        access_token = (
            data.get("AccessToken")
            or data.get("access_token")
            or data.get("accessToken")
        )
        refresh_token = (
            data.get("RefreshToken")
            or data.get("refresh_token")
            or data.get("refreshToken")
        )
        # cookie 兜底（浏览器场景）
        auth_cookie = refresh_cookie = None
        for ck_name, ck_value in resp.cookies.items():
            if ck_name.startswith("AUTH-"):
                auth_cookie = ck_value
            elif ck_name.startswith("REFRESH-"):
                refresh_cookie = ck_value
        if not access_token and auth_cookie:
            access_token = auth_cookie
        if not refresh_token and refresh_cookie:
            # REFRESH cookie 值可能是 URL 编码 JSON，内含 RefreshToken 字段
            try:
                import urllib.parse
                _rt_json = json.loads(urllib.parse.unquote(refresh_cookie))
                refresh_token = _rt_json.get("RefreshToken") or refresh_token
            except Exception:
                refresh_token = refresh_token or refresh_cookie

        if access_token:
            sess.headers.update({"Authorization": f"Bearer {access_token}"})
            print("  ✓ 已切换为登录访问令牌")
        else:
            print("  ⚠ /auth 响应中未发现新的 AccessToken，后续可能缺少 full 权限")
        # 存到 session 供 register_proton 返回
        sess.login_tokens = {
            "uid": data.get("UID") or data.get("Uid"),
            "access_token": access_token,
            "refresh_token": refresh_token,
            "expires_in": data.get("ExpiresIn"),
            "scope": data.get("Scope"),
            "scopes": data.get("Scopes"),
        }
    return data


def api_put(
    sess: Session,
    path: str,
    body: dict,
    log_path: str | None = None,
) -> dict:
    """PUT 请求封装，返回响应 JSON"""
    url = BASE_URL + path
    resp = sess.put(url, json=body)
    print(f"  [PUT]  {log_path or path}  → HTTP {resp.status_code}")
    try:
        return resp.json()
    except Exception:
        return {"_raw": resp.text, "_status": resp.status_code}


# ─────────────────────────────────────────────────
#  随机 Payload 生成（防重放挑战响应）
# ─────────────────────────────────────────────────

def gen_random_payload() -> dict:
    """
    生成 POST /users 中的随机防重放 Payload。
    格式：{随机16位键名: ~2050字符Base64值}
    每次提交必须重新生成，不可复用。
    """
    key = "".join(
        secrets.choice(string.ascii_letters + string.digits) for _ in range(16)
    )
    value = base64.b64encode(os.urandom(1537)).decode()  # ≈ 2050 字符
    return {key: value}


# ─────────────────────────────────────────────────
#  注册主流程
# ─────────────────────────────────────────────────

def refresh_session(
    sess: Session,
    refresh_token: str,
    uid: str,
) -> dict:
    """
    用 refresh token 续期访问令牌（POST /api/auth/refresh）。

    实测（2026-08-02）：
      - 每次 refresh 会【轮换】AccessToken 与 RefreshToken，旧 refresh token 立即作废
      - 新 AccessToken 有效期仍为 ExpiresIn=86400（24h）
      - 浏览器 REFRESH cookie 可持久化约一年，但 refresh token 本身仍按服务端策略
        与每次轮换后的最新值为准，不能长期复用旧 token
      - 响应含 RefreshCounter（续期计数，可作风控/重放检测依据）

    成功后：
      - 更新会话头 Authorization: Bearer <新 AccessToken>
      - 返回 {'access_token', 'refresh_token', 'expires_in', 'uid'}（新令牌对）
    """
    resp = api_post(sess, "/api/auth/refresh", {
        "ResponseType": "token",
        "ClientID": "WebAccount",
        "GrantType": "refresh_token",
        "RefreshToken": refresh_token,
        "UID": uid,
    })
    if resp.get("Code") != 1000:
        raise RuntimeError(f"令牌续期失败（Code={resp.get('Code')}）：{resp}")

    new_access = resp.get("AccessToken") or resp.get("access_token")
    new_refresh = resp.get("RefreshToken") or resp.get("refresh_token")
    if not new_access:
        raise RuntimeError(f"refresh 响应中未找到新 AccessToken：{resp}")

    sess.headers.update({"Authorization": f"Bearer {new_access}"})
    new_uid = resp.get("UID") or uid
    if new_uid:
        sess.headers.update({"X-Pm-Uid": new_uid})

    tokens = {
        "access_token": new_access,
        "refresh_token": new_refresh,
        "expires_in": resp.get("ExpiresIn"),
        "uid": new_uid,
    }
    sess.login_tokens = {
        **getattr(sess, "login_tokens", {}),
        **tokens,
    }
    print(f"  ✓ 令牌续期成功（RefreshCounter={resp.get('RefreshCounter')}），新 AccessToken = {new_access[:16]}...")
    return tokens


def login_proton(
    username: str,
    password: str,
) -> dict:
    """
    登录既有 Proton 账号（SRP-6a），建立已认证会话并捕获取件/续期令牌。

    流程：
      1. 建立匿名 Guest Session（POST /api/auth/v4/sessions）
      2. auth/info：取 Salt / ServerEphemeral / SRPSession
      3. auth：提交 ClientProof，建立登录会话
         - api_post 在 /auth 成功时自动捕获 AccessToken/RefreshToken/UID
         - Bearer 头自动从 guest token 切换为登录访问令牌（full scope）

    返回：
        {'uid', 'user_id', 'email', 'username', 'password',
         'access_token', 'refresh_token', 'expires_in', 'scope', 'sess'}
        'sess' 为已认证的 curl_cffi 会话（供取件/详情/解密复用）。
    """
    proton_email = _as_proton_email(username)
    if not proton_email:
        raise ValueError("username 不能为空")
    username_prefix = proton_email.split("@", 1)[0]

    sess = build_session()
    print("【步骤 1】获取匿名访问令牌（Guest Session）...")
    init_guest_session(sess)

    print("【步骤 2】SRP 登录第一阶段（auth/info）...")
    resp_info = api_post(sess, "/api/core/v4/auth/info", {
        "Username": proton_email,
        "Intent": "Proton",
    })
    if resp_info.get("Code") != 1000:
        raise RuntimeError(f"auth/info 失败：{resp_info}")

    server_modulus_bin = _extract_modulus_from_pgp(resp_info["Modulus"])
    server_ephemeral_b64 = resp_info["ServerEphemeral"]
    srp_session_id = resp_info["SRPSession"]
    srp_salt = base64.b64decode(resp_info["Salt"])

    print("【步骤 3】SRP 登录第二阶段（auth）...")
    srp_login = ProtonSRPUser(password, server_modulus_bin)
    client_ephemeral_b64 = srp_login.get_client_ephemeral_b64()
    client_proof_b64, _session_key = srp_login.process_challenge(
        srp_salt, server_ephemeral_b64
    )
    resp_auth = api_post(sess, "/api/core/v4/auth", {
        "ClientProof": client_proof_b64,
        "ClientEphemeral": client_ephemeral_b64,
        "SRPSession": srp_session_id,
        "Username": proton_email,
        "PersistentCookies": 1,
    })
    if resp_auth.get("Code") != 1000:
        raise RuntimeError(f"SRP 登录失败（Code={resp_auth.get('Code')}）：{resp_auth}")

    uid = resp_auth["UID"]
    user_id = resp_auth["UserID"]
    sess.headers.update({"X-Pm-Uid": uid})

    login_tokens = getattr(sess, "login_tokens", {}) or {}
    access_token = login_tokens.get("access_token")
    refresh_token = login_tokens.get("refresh_token")
    if not access_token:
        access_token = sess.headers.get("Authorization", "").removeprefix("Bearer ").strip() or None

    print("\n" + "═" * 60)
    print(f"✅  登录成功：{proton_email}")
    print(f"    用户ID : {user_id[:30]}...")
    print(f"    UID    : {uid}")
    if access_token:
        expires_in = login_tokens.get("expires_in")
        expires_note = f"ExpiresIn={expires_in}秒" if expires_in else "ExpiresIn未知"
        print(f"    访问令牌 : {access_token[:24]}... （Bearer，{expires_note}，通常约24h）")
    print("═" * 60)

    return {
        "uid": uid,
        "user_id": user_id,
        "email": proton_email,
        "username": username_prefix,
        "password": password,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_in": login_tokens.get("expires_in"),
        "scope": login_tokens.get("scope"),
        "sess": sess,
    }


# ─────────────────────────────────────────────────
#  恢复邮箱设置 / ownership-email 验证
# ─────────────────────────────────────────────────

def _as_proton_email(username: str | None) -> str | None:
    """把用户名前缀规范化为 Proton 邮箱；已传完整邮箱时保持原样。"""
    if not username:
        return None
    value = username.strip()
    if not value:
        return None
    if "@" in value:
        return value
    return f"{value}@proton.me"


def bind_authenticated_session(
    uid: str,
    access_token: str,
    refresh_token: str | None = None,
    expires_in: int | None = None,
    scope: str | None = None,
) -> Session:
    """
    用已保存的 uid/access_token 构造登录态 session，供后续 API 复用。

    注意：`expires_in` 描述 AccessToken 的服务端有效期，实测通常为 86400 秒；
    浏览器 cookie 的一年持久化时间不等于 AccessToken 本身一年有效。
    """
    if not uid:
        raise ValueError("uid 不能为空")
    if not access_token:
        raise ValueError("access_token 不能为空")

    sess = build_session(log_proxy=False)
    sess.headers.update({
        "Authorization": f"Bearer {access_token}",
        "X-Pm-Uid": uid,
    })
    sess.login_tokens = {
        "uid": uid,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_in": expires_in,
        "scope": scope,
    }
    return sess


def unlock_password_scope(
    sess: Session,
    password: str,
    username: str | None = None,
) -> dict:
    """
    解锁 Proton 的 password scope。

    敏感设置写接口（例如恢复邮箱）缺少 password scope 时会返回
    `Code=9102` / `Details.MissingScopes=["password"]`。Web 客户端的流程是：
    `POST /auth/info` 带 `ReauthScope=password`，再用 SRP 结果 `PUT /users/password`。
    """
    if not password:
        raise ValueError("password 不能为空")

    info_body = {
        "Intent": "Proton",
        "ReauthScope": "password",
    }
    proton_email = _as_proton_email(username)
    if proton_email:
        info_body["Username"] = proton_email

    print("【恢复邮箱】解锁 password scope（SRP re-auth）...")
    resp_info = api_post(sess, "/api/core/v4/auth/info", info_body)
    if resp_info.get("Code") != 1000:
        raise RuntimeError(f"password scope auth/info 失败：{resp_info}")

    modulus_bin = _extract_modulus_from_pgp(resp_info["Modulus"])
    srp_salt = base64.b64decode(resp_info["Salt"])
    srp = ProtonSRPUser(password, modulus_bin)
    client_ephemeral_b64 = srp.get_client_ephemeral_b64()
    client_proof_b64, _session_key = srp.process_challenge(
        srp_salt,
        resp_info["ServerEphemeral"],
    )

    resp_unlock = api_put(sess, "/api/core/v4/users/password", {
        "ClientProof": client_proof_b64,
        "ClientEphemeral": client_ephemeral_b64,
        "SRPSession": resp_info["SRPSession"],
    })
    if resp_unlock.get("Code") != 1000:
        raise RuntimeError(f"password scope 解锁失败：{resp_unlock}")

    print("  ✓ password scope 已解锁")
    return resp_unlock


def get_recovery_email_status(settings_payload: dict) -> dict:
    """从 `/settings` 或 `settings/email` 响应中提取恢复邮箱状态。"""
    user_settings = settings_payload.get("UserSettings") or {}
    email_settings = user_settings.get("Email") or {}
    return {
        "value": email_settings.get("Value"),
        "status": email_settings.get("Status"),
        "notify": email_settings.get("Notify"),
        "reset": email_settings.get("Reset"),
        "update_time": email_settings.get("UpdateTime"),
        "email_last_verified_time": user_settings.get("EmailLastVerifiedTime"),
    }


def request_recovery_email_verification(sess: Session) -> dict:
    """
    触发 ownership-email 验证码发送。

    返回值中 `ownership_token` 是一次性敏感凭据，调用方需要保存到内存中等待验证码，
    但不要写入日志或持久文件。
    """
    print("【恢复邮箱】触发 ownership-email 验证挑战...")
    start = api_post(sess, "/api/core/v4/verify/email", {})

    if start.get("Code") == 1000:
        settings = api_get(sess, "/api/core/v4/settings")
        return {
            "stage": "already_verified",
            "start_response": start,
            "settings": settings,
            "recovery_email_status": get_recovery_email_status(settings),
        }

    if start.get("Code") != 9001:
        raise RuntimeError(f"触发恢复邮箱验证码失败：{start}")

    details = start.get("Details") or {}
    methods = details.get("HumanVerificationMethods") or []
    ownership_token = details.get("HumanVerificationToken")
    if "ownership-email" not in methods or not ownership_token:
        raise RuntimeError(f"恢复邮箱验证码挑战缺少 ownership-email 方法：{start}")

    data_resp = api_get(
        sess,
        f"/api/core/v4/verification/ownership-email/{ownership_token}",
        log_path="/api/core/v4/verification/ownership-email/{token}",
    )
    if data_resp.get("Code") != 1000:
        raise RuntimeError(f"拉取 ownership-email 验证数据失败：{data_resp}")

    send_resp = api_post(
        sess,
        f"/api/core/v4/verification/ownership-email/{ownership_token}",
        {},
        log_path="/api/core/v4/verification/ownership-email/{token}",
    )
    if send_resp.get("Code") != 1000:
        raise RuntimeError(f"发送 ownership-email 验证码失败：{send_resp}")

    print("  ✓ 验证码已发送到恢复邮箱")
    return {
        "stage": "waiting_verification_code",
        "ownership_token": ownership_token,
        "start_response": start,
        "verification_data": data_resp,
        "send_response": send_resp,
    }


def confirm_recovery_email_verification(
    sess: Session,
    ownership_token: str,
    verification_code: str,
) -> dict:
    """提交 6 位验证码并确认恢复邮箱，最终以 `/settings` 的 `Email.Status` 为准。"""
    if not ownership_token:
        raise ValueError("ownership_token 不能为空")
    code = (verification_code or "").strip()
    if not code:
        raise ValueError("verification_code 不能为空")

    print("【恢复邮箱】提交 ownership-email 验证码...")
    token_resp = api_post(
        sess,
        f"/api/core/v4/verification/ownership-email/{ownership_token}/{code}",
        {},
        log_path="/api/core/v4/verification/ownership-email/{token}/{code}",
    )
    if token_resp.get("Code") != 1000:
        raise RuntimeError(f"恢复邮箱验证码校验失败：{token_resp}")

    verification_token = token_resp.get("Token") or ownership_token
    verify_resp = api_post(
        sess,
        "/api/core/v4/verify/email",
        {},
        extra_headers={
            "X-Pm-Human-Verification-Token": verification_token,
            "X-Pm-Human-Verification-Token-Type": "ownership-email",
        },
    )
    if verify_resp.get("Code") != 1000:
        raise RuntimeError(f"恢复邮箱最终确认失败：{verify_resp}")

    settings = api_get(sess, "/api/core/v4/settings")
    status = get_recovery_email_status(settings)
    if status.get("status") != 1:
        raise RuntimeError(f"恢复邮箱未进入已验证状态：{status}")

    print("  ✓ 恢复邮箱已验证完成（Status=1）")
    return {
        "stage": "verified",
        "token_response": {
            "Code": token_resp.get("Code"),
            "TokenPresent": bool(token_resp.get("Token")),
        },
        "verify_response": verify_resp,
        "settings": settings,
        "recovery_email_status": status,
    }


def set_recovery_email(
    sess: Session,
    password: str,
    recovery_email: str,
    username: str | None = None,
    verification_code: str | None = None,
    persist_password_scope: bool = True,
    send_code: bool = True,
) -> dict:
    """
    设置 Proton 恢复邮箱，并可选完成 6 位验证码确认。

    - 传入 `verification_code`：函数会完整跑到 `Email.Status=1`。
    - 不传 `verification_code`：函数会写入邮箱并发送验证码，返回 `ownership_token`
      给调用方，后续可调用 `confirm_recovery_email_verification()`。
    """
    if not recovery_email or "@" not in recovery_email:
        raise ValueError("recovery_email 必须是完整邮箱地址")

    unlock_password_scope(sess, password=password, username=username)

    print("【恢复邮箱】写入恢复邮箱地址...")
    update_resp = api_put(sess, "/api/core/v4/settings/email", {
        "Email": recovery_email,
        "PersistPasswordScope": bool(persist_password_scope),
    })
    if update_resp.get("Code") != 1000:
        raise RuntimeError(f"写入恢复邮箱失败：{update_resp}")

    result = {
        "stage": "email_written",
        "update_response": update_resp,
        "recovery_email_status": get_recovery_email_status(update_resp),
    }
    if not send_code:
        return result

    verification = request_recovery_email_verification(sess)
    result.update({
        "stage": verification["stage"],
        "ownership_token": verification.get("ownership_token"),
        "verification_response": {
            "start_code": (verification.get("start_response") or {}).get("Code"),
            "send_code": (verification.get("send_response") or {}).get("Code"),
        },
    })

    if verification["stage"] == "already_verified":
        result.update({
            "recovery_email_status": verification.get("recovery_email_status"),
            "settings": verification.get("settings"),
        })
        return result

    if verification_code is None:
        return result

    confirm_result = confirm_recovery_email_verification(
        sess,
        verification["ownership_token"],
        verification_code,
    )
    result.update(confirm_result)
    return result


def register_proton(
    username: str,
    password: str,
    verify_email: str,
) -> dict:
    """
    执行 Proton Mail 完整注册流程。
    验证码通过交互式 input() 在发送后实时读取。

    参数：
        username     - 不含 @proton.me 的用户名
        password     - 账号密码
        verify_email - 用于人机验证的邮箱（你提供的外部邮箱）

    返回：
        {'uid': ..., 'user_id': ..., 'email': ..., 'local_key': ...}
    """
    sess = build_session()

    # ═══════════════════════════════════════════════════
    # 步骤 0：获取匿名 Guest Session（Proton 新版 API 前置要求）
    # ═══════════════════════════════════════════════════
    print("\n【步骤 0】获取匿名访问令牌（Guest Session）...")
    init_guest_session(sess)

    # ═══════════════════════════════════════════════════
    # 步骤 1：检查用户名可用性
    # ═══════════════════════════════════════════════════
    print("\n【步骤 1】检查用户名可用性...")
    check_name = f"{username}@proton.me"
    resp = api_get(sess, "/api/core/v4/users/available", {
        "Name": check_name,
        "ParseDomain": "1",
    })
    if resp.get("Code") == 12106:
        sug = resp.get("Details", {}).get("Suggestions", [])
        raise ValueError(f"用户名 '{username}' 已被占用，推荐可用名：{sug}")
    print(f"  ✓ 用户名 '{username}' 可用")

    # ═══════════════════════════════════════════════════
    # 步骤 2：获取 SRP 模数（注册前）
    # ═══════════════════════════════════════════════════
    print("\n【步骤 2】获取 SRP 模数...")
    resp = api_get(sess, "/api/core/v4/auth/modulus")
    if resp.get("Code") != 1000:
        raise RuntimeError(f"获取 Modulus 失败：{resp}")

    modulus_pgp_block = resp["Modulus"]
    modulus_id = resp["ModulusID"]
    modulus_bin = _extract_modulus_from_pgp(modulus_pgp_block)
    print(f"  ✓ ModulusID = {modulus_id[:24]}...")

    # ═══════════════════════════════════════════════════
    # 步骤 3：生成 SRP Salt + Verifier（客户端本地）
    # ═══════════════════════════════════════════════════
    print("\n【步骤 3】生成 SRP Salt + Verifier...")
    srp_client = ProtonSRPUser(password, modulus_bin)
    salt_bytes = os.urandom(SALT_LEN_BYTES)
    verifier_bytes = srp_client.generate_verifier(salt_bytes)
    salt_b64 = base64.b64encode(salt_bytes).decode()
    verifier_b64 = base64.b64encode(verifier_bytes).decode()
    print(f"  ✓ Salt = {salt_b64}")
    print(f"  ✓ Verifier = {verifier_b64[:32]}...（共 {len(verifier_bytes)} 字节）")

    # ═══════════════════════════════════════════════════
    # 步骤 4：首次 POST /users（预期 422 触发人机验证）
    # ═══════════════════════════════════════════════════
    print("\n【步骤 4】首次提交创建用户请求（预期 422 触发人机验证）...")
    create_body = {
        "Type": 1,
        "Username": username,
        "Payload": gen_random_payload(),
        "Domain": "proton.me",
        "Auth": {
            "ModulusID": modulus_id,
            "Version": PM_SRP_VERSION,
            "Salt": salt_b64,
            "Verifier": verifier_b64,
        },
    }
    resp_create = api_post(sess, "/api/core/v4/users", create_body)

    # ── 分支：直接创建成功（无风控）──
    if resp_create.get("Code") == 1000:
        print("  ✓ 账号创建成功（无需人机验证）")
        user_data = resp_create.get("User", {})

    # ── 分支：422 触发人机验证（常规路径）──
    elif resp_create.get("Code") == 9001:
        hv_details = resp_create.get("Details", {})
        hv_methods = hv_details.get("HumanVerificationMethods", [])
        hv_token   = hv_details.get("HumanVerificationToken", "")
        print(f"  ℹ 触发人机验证（支持方式：{hv_methods}）")
        print(f"  ℹ HumanVerificationToken = {hv_token[:16]}...")

        # ── 步骤 4a：发送验证码到外部邮箱 ──
        # 重要：HAR 请求 31 显示，发送验证码时【不携带 HV Token 头】，
        # 只带通用头 + cookie。HV Token 用于【二次创建用户】(4b) 时携带。
        # 若此处误带 HV Token，服务端判定验证邮箱与 HV 会话不匹配，
        # 返回 85102「暂不允许验证邮箱地址」。
        print(f"\n【步骤 4a】向 {verify_email} 发送邮箱验证码...")
        code_body = {
            "Type": "email",
            "Destination": {"Address": verify_email},
        }
        # 不带 HV Token 头（对齐 HAR），发送验证码由服务端独立下发
        code_resp = api_post(sess, "/api/core/v4/users/code", code_body)
        if code_resp.get("Code") == 1000:
            print("  ✓ 验证码已发送，请检查你的邮箱")
        else:
            print(f"  ⚠ 发送验证码响应异常：{code_resp}")
            print("  ⚠ 仍继续等待你输入验证码（可能邮件稍后到达）")

        # ── ★ 暂停，等用户输入验证码 ★ ──
        print()
        print("=" * 60)
        print(f"  请前往 {verify_email} 查收 Proton 验证码邮件")
        print("  收到验证码后，在下方输入并按 Enter 继续")
        print("=" * 60)
        verify_code = input("  邮箱验证码: ").strip()
        if not verify_code:
            raise ValueError("验证码不能为空，请重新运行脚本并输入验证码")
        print()

        # ── 步骤 4b：携带验证令牌二次提交 ──
        print(f"【步骤 4b】携带验证码重新提交创建用户请求...")
        hv_headers = {
            "X-Pm-Human-Verification-Token": f"{verify_email}:{verify_code}",
            "X-Pm-Human-Verification-Token-Type": "email",
        }
        # 必须重新生成 Payload（防重放）
        create_body["Payload"] = gen_random_payload()
        resp_create2 = api_post(sess, "/api/core/v4/users", create_body, extra_headers=hv_headers)

        if resp_create2.get("Code") != 1000:
            raise RuntimeError(
                f"携带验证码创建用户失败（Code={resp_create2.get('Code')}）：\n"
                f"{json.dumps(resp_create2, ensure_ascii=False, indent=2)}"
            )
        print("  ✓ 账号创建成功！")
        user_data = resp_create2.get("User", {})

    else:
        raise RuntimeError(
            f"创建用户请求失败（Code={resp_create.get('Code')}）：\n"
            f"{json.dumps(resp_create, ensure_ascii=False, indent=2)}"
        )

    created_user_id = user_data.get("ID", "")
    print(f"  用户 ID = {created_user_id[:30]}...")
    print(f"  邮箱   = {user_data.get('Email', '')}")

    # ═══════════════════════════════════════════════════
    # 步骤 5：SRP 登录第一阶段（auth/info）
    # ═══════════════════════════════════════════════════
    print("\n【步骤 5】SRP 登录第一阶段（auth/info）...")
    resp_info = api_post(sess, "/api/core/v4/auth/info", {
        "Username": f"{username}@proton.me",
        "Intent": "Proton",
    })
    if resp_info.get("Code") != 1000:
        raise RuntimeError(f"auth/info 失败：{resp_info}")

    server_modulus_pgp = resp_info["Modulus"]
    server_modulus_bin = _extract_modulus_from_pgp(server_modulus_pgp)
    server_ephemeral_b64 = resp_info["ServerEphemeral"]
    srp_salt_b64_from_server = resp_info["Salt"]
    srp_session_id = resp_info["SRPSession"]
    srp_salt_from_server = base64.b64decode(srp_salt_b64_from_server)

    print(f"  ✓ SRPSession = {srp_session_id[:16]}...")
    print(f"  ✓ 服务端 Salt 与注册时一致：{srp_salt_b64_from_server == salt_b64}")

    # ═══════════════════════════════════════════════════
    # 步骤 6：SRP 登录第二阶段（auth）
    # ═══════════════════════════════════════════════════
    print("\n【步骤 6】SRP 登录第二阶段（auth）...")
    # 用服务端返回的模数重建 SRP 客户端（两次模数应一致）
    srp_login = ProtonSRPUser(password, server_modulus_bin)
    client_ephemeral_b64 = srp_login.get_client_ephemeral_b64()
    client_proof_b64, session_key = srp_login.process_challenge(
        srp_salt_from_server, server_ephemeral_b64
    )

    resp_auth = api_post(sess, "/api/core/v4/auth", {
        "ClientProof": client_proof_b64,
        "ClientEphemeral": client_ephemeral_b64,
        "SRPSession": srp_session_id,
        "Username": f"{username}@proton.me",
        "PersistentCookies": 1,
    })
    if resp_auth.get("Code") != 1000:
        raise RuntimeError(f"SRP 登录失败（Code={resp_auth.get('Code')}）：{resp_auth}")

    uid = resp_auth["UID"]
    user_id = resp_auth["UserID"]
    print(f"  ✓ 会话建立成功，UID = {uid}")

    # ── 会话切换：同步登录后的 UID ──
    # api_post 已在 /auth 成功时优先把 Bearer 令牌切换为登录访问令牌；
    # 此处只同步 UID，避免后续请求仍使用 Guest UID。
    sess.headers.update({"X-Pm-Uid": uid})

    # ═══════════════════════════════════════════════════
    # 步骤 7：获取地址列表（取 AddressID）
    # ═══════════════════════════════════════════════════
    print("\n【步骤 7】获取地址列表...")
    resp_addr = api_get(sess, "/api/core/v4/addresses", {"Page": "0", "PageSize": "50"})
    if resp_addr.get("Code") != 1000:
        raise RuntimeError(f"获取地址失败：{resp_addr}")
    addresses = resp_addr.get("Addresses", [])
    if not addresses:
        raise RuntimeError("地址列表为空，无法获取 AddressID")
    address_id = addresses[0]["ID"]
    print(f"  ✓ AddressID = {address_id[:30]}...")

    # ═══════════════════════════════════════════════════
    # 步骤 8：生成 PGP 密钥对并上传（keys/setup）
    # ═══════════════════════════════════════════════════
    print("\n【步骤 8】生成 PGP 密钥对（Curve25519）...")
    keys = generate_keys_for_proton(username, password)
    print("  ✓ 主密钥 & 地址密钥生成完毕")

    # ── 步骤 8a：重新获取 modulus 并生成 Auth（密码重确认）──
    # Proton 在 keys/setup 时要求携带 Auth 字段，用于重新验证密码：
    #   1. 重新 GET /auth/modulus（与创建时的 modulus 不同，每次新签）
    #   2. 用新 modulus + 新随机 Salt 重新生成 Verifier
    #   3. 将 {ModulusID, Version, Salt, Verifier} 作为 Auth 提交
    # 若不携带 Auth，返回 Code=2000「缺少必要的属性 Auth」
    print("\n【步骤 8a】重新获取 modulus 并生成 Auth（密码重确认）...")
    resp_mod2 = api_get(sess, "/api/core/v4/auth/modulus")
    if resp_mod2.get("Code") != 1000:
        raise RuntimeError(f"重新获取 Modulus 失败：{resp_mod2}")
    modulus2_bin = _extract_modulus_from_pgp(resp_mod2["Modulus"])
    setup_srp = ProtonSRPUser(password, modulus2_bin)
    setup_salt_bytes = os.urandom(SALT_LEN_BYTES)
    setup_verifier_bytes = setup_srp.generate_verifier(setup_salt_bytes)
    setup_auth = {
        "ModulusID": resp_mod2["ModulusID"],
        "Version": PM_SRP_VERSION,
        "Salt": base64.b64encode(setup_salt_bytes).decode(),
        "Verifier": base64.b64encode(setup_verifier_bytes).decode(),
    }
    print(f"  ✓ 新 ModulusID = {resp_mod2['ModulusID'][:24]}...")
    print(f"  ✓ Auth 生成完毕（Salt = {setup_auth['Salt']}）")

    print("\n【步骤 8b】上传密钥（/keys/setup）...")
    setup_body = {
        "KeySalt": keys["key_salt"],
        "PrimaryKey": keys["primary_key_armored"],
        "Auth": setup_auth,
        "AddressKeys": [
            {
                "AddressID": address_id,
                "PrivateKey": keys["address_key_armored"],
                "SignedKeyList": {
                    "Data": keys["skl_data"],
                    "Signature": keys["skl_signature"],
                },
                "Token": keys["token_armored"],
                "Signature": keys["token_signature_armored"],
            }
        ],
    }
    resp_setup = api_post(sess, "/api/core/v4/keys/setup", setup_body)
    if resp_setup.get("Code") != 1000:
        raise RuntimeError(f"密钥上传失败（Code={resp_setup.get('Code')}）：{resp_setup}")
    print("  ✓ 密钥上传成功！")
    setup_user = resp_setup.get("User", {})
    print(f"  MnemonicStatus = {setup_user.get('MnemonicStatus')}")
    print(f"  ToMigrate      = {setup_user.get('ToMigrate')} （0 = 初始化完成）")

    # ═══════════════════════════════════════════════════
    # 步骤 9：设置界面语言
    # ═══════════════════════════════════════════════════
    print("\n【步骤 9】设置语言 zh_CN...")
    api_put(sess, "/api/core/v4/settings/locale", {"Locale": "zh_CN"})
    print("  ✓ 语言设置完成")

    # ═══════════════════════════════════════════════════
    # 步骤 10：保存本地会话密钥
    # ═══════════════════════════════════════════════════
    print("\n【步骤 10】保存本地会话密钥...")
    local_key = base64.b64encode(os.urandom(32)).decode()
    api_put(sess, "/api/auth/v4/sessions/local/key", {"Key": local_key})
    print("  ✓ 本地密钥保存完成")

    # ── 汇总会话令牌（取件/续期凭证）──
    # login_tokens 由 api_post 在 /auth 成功后捕获（实测响应体返回）：
    #   access_token   = Bearer 访问令牌（ExpiresIn≈24h，取件用它）
    #   refresh_token  = 续期令牌（调 /api/auth/refresh 换新对）
    login_tokens = getattr(sess, "login_tokens", {}) or {}
    access_token = login_tokens.get("access_token")
    refresh_token = login_tokens.get("refresh_token")
    if not access_token:
        # 兜底：从 session 头再取一次
        access_token = sess.headers.get("Authorization", "").removeprefix("Bearer ").strip() or None

    print("\n" + "═" * 60)
    print("✅  Proton Mail 注册 & 初始化全部完成！")
    print(f"    邮箱   : {username}@proton.me")
    print(f"    用户ID : {user_id[:30]}...")
    print(f"    UID    : {uid}")
    if access_token:
        expires_in = login_tokens.get("expires_in")
        expires_note = f"ExpiresIn={expires_in}秒" if expires_in else "ExpiresIn未知"
        print(f"    访问令牌 : {access_token[:24]}... （Bearer，{expires_note}，通常约24h）")
    print("═" * 60)

    return {
        "uid": uid,
        "user_id": user_id,
        "email": f"{username}@proton.me",
        "username": username,
        "password": password,
        "local_key": local_key,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_in": login_tokens.get("expires_in"),
        "scope": login_tokens.get("scope"),
    }


# ─────────────────────────────────────────────────
#  取件（邮件列表 / 单封详情 / PGP 解密）
# ─────────────────────────────────────────────────

def fetch_messages(
    sess: Session,
    page: int = 0,
    page_size: int = 10,
    label_id: str = "0",
) -> list:
    """
    获取收件箱邮件列表（元数据，不含正文）。

    - URL: GET /api/mail/v4/messages?Page=&PageSize=&LabelID=0
    - 需要已认证会话：Authorization: Bearer <access_token> + X-Pm-Uid（缺一即 401）
    - 返回 [message, ...]，每项含 ID/Subject/SenderAddress/Time/Unread 等
    """
    resp = api_get(sess, "/api/mail/v4/messages", {
        "Page": str(page),
        "PageSize": str(page_size),
        "LabelID": label_id,
    })
    if resp.get("Code") != 1000:
        raise RuntimeError(f"获取邮件列表失败（Code={resp.get('Code')}）：{resp}")
    return resp.get("Messages", [])


def fetch_message(
    sess: Session,
    message_id: str,
    format_body: bool = True,
) -> dict:
    """
    获取单封邮件详情。

    - URL: GET /api/mail/v4/messages/<MessageID>
    - 查询参数 Format=1：服务端返回预渲染的 HTML 正文（含内联样式），
      同时保留 MIME 结构的 MimeType/MimeTypeFilter；远程图片默认不加载。
    - 返回 Message 对象：Body / MimeType / Subject / SenderAddress / ToList /
      CCList / Time / Header（RFC 822 头部原文）等
    """
    params = {}
    if format_body:
        params["Format"] = "1"
    resp = api_get(sess, f"/api/mail/v4/messages/{message_id}", params or None)
    if resp.get("Code") != 1000:
        raise RuntimeError(f"获取邮件详情失败（Code={resp.get('Code')}）：{resp}")
    return resp.get("Message", {})


def get_address_private_keys(sess: Session) -> list:
    """
    拉取当前账号全部地址的 PGP 私钥（解密邮件正文必需）。

    - URL: GET /api/core/v4/addresses?Page=0&PageSize=50
    - 每个地址的 Keys[].PrivateKey 是 armored OpenPGP 私钥块
      （注册时客户端本地生成并上传，服务端只存公钥 + 加密私钥）。
    - 返回 [{address_id, key_id, email, armored, token}]；地址若未配置密钥则跳过。
    """
    resp = api_get(sess, "/api/core/v4/addresses", {"Page": "0", "PageSize": "50"})
    if resp.get("Code") != 1000:
        raise RuntimeError(f"获取地址失败（Code={resp.get('Code')}）：{resp}")

    result = []
    for addr in resp.get("Addresses", []):
        keys = addr.get("Keys", []) or []
        for key in keys:
            armored = key.get("PrivateKey")
            if armored:
                result.append({
                    "address_id": addr.get("ID"),
                    "key_id": key.get("ID"),
                    "email": addr.get("Email"),
                    "armored": armored,
                    "token": key.get("Token"),
                })
    return result


def get_user_private_keys(sess: Session) -> list:
    """拉取当前账号主私钥，供地址 key token 解密使用。"""
    resp = api_get(sess, "/api/core/v4/users")
    if resp.get("Code") != 1000:
        raise RuntimeError(f"获取用户主密钥失败（Code={resp.get('Code')}）：{resp}")
    result = []
    for key in (resp.get("User", {}).get("Keys") or []):
        armored = key.get("PrivateKey")
        if armored:
            result.append({
                "key_id": key.get("ID"),
                "armored": armored,
            })
    return result


def get_key_salts(sess: Session) -> list:
    """
    拉取当前账号的 KeySalt 列表。

    Proton Web 解锁私钥时需要 KeySalt 派生 key_password；注册初始化时上传的
    KeySalt 不在地址 Keys[].PrivateKey 旁边返回，需通过独立端点读取。
    """
    resp = api_get(sess, "/api/core/v4/keys/salts")
    if resp.get("Code") != 1000:
        raise RuntimeError(f"获取 KeySalt 失败（Code={resp.get('Code')}）：{resp}")
    salts = resp.get("KeySalts")
    if isinstance(salts, list):
        return salts
    if isinstance(salts, dict):
        return [salts]
    key_salt = resp.get("KeySalt")
    if isinstance(key_salt, str):
        return [{"KeySalt": key_salt}]
    if isinstance(key_salt, dict):
        return [key_salt]
    return []


def get_mailbox_key_password(sess: Session, password: str) -> str:
    """
    获取用于解锁 OpenPGP 私钥的 Proton key_password。

    新版兼容流程：原始登录密码 + KeySalt → 派生私钥口令。
    若账号是早期脚本用原始密码直接加密的旧数据，端点缺失或无盐时退回原始密码。
    """
    try:
        salts = get_key_salts(sess)
    except Exception as e:
        print(f"  ⚠ 获取 KeySalt 失败，退回原始密码解锁旧私钥：{e}")
        return password
    if not salts:
        print("  ⚠ KeySalt 列表为空，退回原始密码解锁旧私钥")
        return password
    key_salt = salts[0].get("KeySalt") or salts[0].get("Salt")
    if not key_salt:
        print("  ⚠ KeySalt 字段缺失，退回原始密码解锁旧私钥")
        return password
    return derive_key_password(password, key_salt)


def get_address_key_passphrases(
    sess: Session,
    password: str,
    address_keys: list,
) -> dict:
    """
    构造每把地址私钥的候选解锁口令。

    Proton Web 的新链路是：密码 + 用户 KeySalt 解锁主私钥，主私钥解开
    AddressKey.Token，Token 明文再解锁地址私钥。旧脚本曾直接用密码或
    key_password 保护地址私钥，所以保留 fallback。
    """
    passphrases = {ak.get("key_id"): [] for ak in address_keys}
    fallback = []
    key_password = None
    try:
        key_password = get_mailbox_key_password(sess, password)
        fallback.append(key_password)
    except Exception as e:
        print(f"  ⚠ 派生用户 key_password 失败：{e}")
    fallback.append(password)

    try:
        user_keys = get_user_private_keys(sess)
    except Exception as e:
        print(f"  ⚠ 获取主私钥失败，退回旧式口令解锁地址私钥：{e}")
        user_keys = []

    for ak in address_keys:
        key_id = ak.get("key_id")
        token = ak.get("token")
        if token and user_keys and key_password:
            token_plaintext = _decrypt_address_token(token, user_keys, key_password)
            if token_plaintext:
                passphrases.setdefault(key_id, []).append(token_plaintext)
        for item in fallback:
            if item and item not in passphrases.setdefault(key_id, []):
                passphrases[key_id].append(item)
    return passphrases


def _decrypt_address_token(token_armored: str, user_keys: list, key_password: str) -> str | None:
    """用主私钥解开地址 key token；失败返回 None，让调用方走旧式 fallback。"""
    last_err = None
    for user_key in user_keys:
        try:
            priv_key = pgpy.PGPKey.from_blob(user_key["armored"])[0]
            with priv_key.unlock(key_password):
                dec = priv_key.decrypt(pgpy.PGPMessage.from_blob(token_armored))
                return _pgp_message_to_bytes(dec.message).decode("utf-8", errors="replace")
        except Exception as e:
            last_err = e
            continue
    if last_err:
        print(f"  ⚠ 地址 Token 解密失败，尝试旧式口令：{last_err}")
    return None


def decrypt_message_body(
    message: dict,
    address_keys: list,
    key_passphrases,
) -> str:
    """
    用账号地址私钥解密单封邮件正文，返回纯文本（HTML 优先，纯文本兜底）。

    Proton 邮件正文是 OpenPGP 加密的 armored 文本（-----BEGIN PGP MESSAGE-----），
    用地址私钥对应 passphrase 解锁后解密。流程：
      1. 加载地址私钥（pgpy.PGPKey.from_blob）并解锁
      2. 优先用收件地址匹配私钥；匹配不到时尝试所有地址私钥
      3. 解出明文的 PGPMessage，再按 MimeType 取纯文本内容

    返回：正文纯文本。若正文非 PGP（明文/HTML 已渲染），原样截断返回。
    """
    body = message.get("Body") or ""
    if not body:
        return "（无正文）"
    if "BEGIN PGP MESSAGE" not in body:
        # 非加密正文（理论上不会有；纯 API 客户端通常只会拿到 PGP 密文）
        return body[:2000]

    # ── 组装 (收件地址 → armored 私钥) 映射 ──
    addr_to_key = {}
    for ak in address_keys:
        addr_to_key[ak["email"]] = ak

    # 优先用收件地址匹配私钥
    to_addrs = [t.get("Address") for t in (message.get("ToList") or []) if t.get("Address")]
    to_addrs += [t.get("Address") for t in (message.get("CCList") or []) if t.get("Address")]
    candidates = []
    for addr in to_addrs:
        if addr in addr_to_key:
            candidates.append(addr_to_key[addr])
    # 收件地址匹配不到时，退回用所有地址私钥逐个试
    for ak in addr_to_key.values():
        if ak not in candidates:
            candidates.append(ak)

    # ── 依次尝试解密 ──
    last_err = None
    if isinstance(key_passphrases, str):
        default_passphrases = [key_passphrases]
        passphrase_map = {}
    else:
        default_passphrases = []
        passphrase_map = key_passphrases or {}

    for ak in candidates:
        key_id = ak.get("key_id")
        armored = ak["armored"]
        candidates_passphrases = passphrase_map.get(key_id) or default_passphrases
        for passphrase in candidates_passphrases:
            try:
                plaintext = _decrypt_with_key(body, armored, passphrase)
                return plaintext
            except Exception as e:
                last_err = e
                continue
    raise RuntimeError(f"解密失败：无法用地址私钥解密正文（最后错误：{last_err}）")


def _decrypt_with_key(ciphertext: str, armored: str, key_password: str) -> str:
    """
    用单把地址私钥解密 Proton 邮件正文，返回纯文本。

    关键：pgpy 的 PGPKey.decrypt 使用「文件对象」自身的私钥材料解密，
    因此必须在 unlock 上下文内调用 priv_key.decrypt（不是 unlock 返回的副本）。
    每次新建 PGPKey 实例，避免跨 unlock 块共享解锁状态。
    Proton 正文可能再套一层 PGP MESSAGE 壳（整封 MIME 二次加密），循环剥壳。
    """
    priv_key = pgpy.PGPKey.from_blob(armored)[0]
    with priv_key.unlock(key_password):
        # 关键：pgpy 对解密结果要用 dec.message（bytes 明文），不能用 str(dec)。
        # str(dec) 会把非加密的 PGPMessage 重新序列化成 armored，导致永远剥不完。
        dec = priv_key.decrypt(pgpy.PGPMessage.from_blob(ciphertext))
        plaintext = _pgp_message_to_bytes(dec.message)
        # Proton 正文（Format=1）是多层 PGP 嵌套：外层 armor → 内层 base64 PGP → … → HTML。
        # 每次只要明文仍是 armored PGP 密文，就继续剥壳，直到拿到 HTML/纯文本。
        while plaintext.lstrip().startswith(b"-----BEGIN PGP MESSAGE"):
            dec = priv_key.decrypt(pgpy.PGPMessage.from_blob(plaintext))
            plaintext = _pgp_message_to_bytes(dec.message)
    # 解密失败时 pgpy 会把原始密文原样塞回 message；此处仅当解出 HTML/纯文本才返回
    return plaintext.decode("utf-8", errors="replace")


def _pgp_message_to_bytes(message) -> bytes:
    """兼容 pgpy 解密结果可能返回 bytes、bytearray 或 str 的情况。"""
    if message is None:
        return b""
    if isinstance(message, bytes):
        return message
    if isinstance(message, bytearray):
        return bytes(message)
    if isinstance(message, str):
        return message.encode("utf-8")
    return bytes(message)


def fetch_and_print_mail(
    sess: Session,
    creds: dict,
    limit: int = 5,
) -> None:
    """
    取件入口：拉取收件箱列表 → 逐封打印单封详情（标题/收发件人/时间/正文）。

    - 列表：fetch_messages（元数据）
    - 单封：fetch_message(Format=1)（预渲染 HTML 正文）
    - 解密：用 get_address_private_keys + decrypt_message_body 还原纯文本
    """
    messages = fetch_messages(sess, page=0, page_size=limit, label_id="0")
    if not messages:
        print("收件箱为空。")
        return
    address_keys = get_address_private_keys(sess)
    key_passphrases = get_address_key_passphrases(sess, creds["password"], address_keys)

    print(f"共 {len(messages)} 封邮件：\n")
    for i, msg in enumerate(messages, 1):
        print(f"──────────────── # {i} ────────────────")
        print(f"主题    : {msg.get('Subject', '(无主题)')}")
        print(f"发件人  : {msg.get('SenderName') or ''} <{msg.get('SenderAddress')}>")
        from datetime import datetime
        ts = msg.get("Time") or 0
        print(f"时间    : {datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"消息ID  : {msg.get('ID')}")
        unread = msg.get("Unread") or 0
        print(f"状态    : {'未读' if unread else '已读'} · 附件 {msg.get('NumAttachments', 0)}")

        try:
            detail = fetch_message(sess, msg["ID"], format_body=True)
        except Exception as e:
            print(f"  ⚠ 详情拉取失败：{e}")
            continue

        to_addrs = ", ".join(t.get("Address", "") for t in (detail.get("ToList") or []) if t.get("Address"))
        print(f"收件人  : {to_addrs or '(自己)'}")
        print(f"MIME    : {detail.get('MimeType', 'text/plain')} / {detail.get('MimeTypeFilter')}")

        try:
            body_text = decrypt_message_body(detail, address_keys, key_passphrases)
        except Exception as e:
            print(f"  ⚠ 正文解密失败：{e}")
            print(f"  正文原始长度：{len(detail.get('Body') or '')} 字符")
            continue

        print("正文    :")
        print("  " + body_text.replace("\n", "\n  ")[:4000])
        print()


def main_mail():
    print("=" * 60)
    print("  Proton Mail 取件工具  （登录 + 列表 + 单封详情 + PGP 解密）")
    print("=" * 60)
    print()

    username = input("用户名（不含 @proton.me，仅填前缀部分）: ").strip()
    if not username:
        print("[错误] 用户名不能为空")
        sys.exit(1)
    # 容错：用户若误输入完整邮箱（含 @proton.me），自动截断取前缀
    if username.lower().endswith("@proton.me"):
        username = username[: -len("@proton.me")]
        print(f"  [提示] 已自动去除域名后缀，实际使用用户名：{username}")
    password = input("密码: ").strip()
    if not password:
        print("[错误] 密码不能为空")
        sys.exit(1)

    try:
        print()
        creds = login_proton(username, password)
        print()
        sess = creds.pop("sess")
        fetch_and_print_mail(sess, creds)
    except Exception as e:
        print(f"\n[错误] {e}")
        import traceback
        traceback.print_exc()


def main_recovery_email():
    print("=" * 60)
    print("  Proton Mail 恢复邮箱设置工具")
    print("=" * 60)
    print()

    username = input("用户名（不含 @proton.me，也可填完整邮箱）: ").strip()
    if not username:
        print("[错误] 用户名不能为空")
        sys.exit(1)
    if username.lower().endswith("@proton.me"):
        username = username[: -len("@proton.me")]
        print(f"  [提示] 已自动去除域名后缀，实际使用用户名：{username}")

    password = input("密码: ").strip()
    if not password:
        print("[错误] 密码不能为空")
        sys.exit(1)

    recovery_email = input("要设置的恢复邮箱: ").strip()
    if not recovery_email:
        print("[错误] 恢复邮箱不能为空")
        sys.exit(1)

    try:
        print()
        creds = login_proton(username, password)
        sess = creds.pop("sess")

        result = set_recovery_email(
            sess=sess,
            password=password,
            username=username,
            recovery_email=recovery_email,
            verification_code=None,
        )

        if result.get("stage") == "waiting_verification_code":
            print()
            print("=" * 60)
            print(f"  请前往 {recovery_email} 查收 6 位验证码")
            print("  收到验证码后，在下方输入并按 Enter 继续")
            print("=" * 60)
            code = input("  恢复邮箱验证码: ").strip()
            result = confirm_recovery_email_verification(
                sess,
                result["ownership_token"],
                code,
            )

        status = result.get("recovery_email_status") or {}
        print("\n最终结果：")
        print(json.dumps({
            "stage": result.get("stage"),
            "recovery_email_status": status,
        }, ensure_ascii=False, indent=2))
    except Exception as e:
        print(f"\n[错误] {e}")
        import traceback
        traceback.print_exc()


# ─────────────────────────────────────────────────
#  交互式入口
# ─────────────────────────────────────────────────

def _gen_username() -> str:
    """随机生成用户名：3个小写字母 + 6位数字，例如 abc123456"""
    letters = "".join(secrets.choice(string.ascii_lowercase) for _ in range(3))
    digits  = "".join(secrets.choice(string.digits) for _ in range(6))
    return letters + digits


def _gen_password() -> str:
    """随机生成12位密码：字母 + 数字 + 简单符号（!@#$%^&*-_）"""
    # 字符集：大小写字母 + 数字 + 简单特殊字符
    charset = string.ascii_letters + string.digits + "!@#$%^&*-_"
    # 保证至少含一个大写、一个小写、一个数字、一个符号
    pwd = [
        secrets.choice(string.ascii_uppercase),
        secrets.choice(string.ascii_lowercase),
        secrets.choice(string.digits),
        secrets.choice("!@#$%^&*-_"),
    ]
    # 补充到12位
    pwd += [secrets.choice(charset) for _ in range(8)]
    # 打乱顺序
    secrets.SystemRandom().shuffle(pwd)
    return "".join(pwd)


def main():
    print("=" * 60)
    print("  Proton Mail 注册工具  （curl_cffi + 纯 SRP-6a 实现）")
    print("=" * 60)
    print()
    print("【交互流程说明】")
    print("  1. 用户名 & 密码自动随机生成，你只需填写接收验证码的邮箱")
    print("  2. 脚本自动完成前置步骤并向你的邮箱发送验证码")
    print("  3. ★ 收到验证码后，在提示处输入并按 Enter ★")
    print("  4. 脚本自动完成后续注册与密钥初始化")
    print()
    print("【提示】用 python proton_register.py --mail 可进入取件模式")
    print("       （登录 → 收件箱列表 → 单封详情 → PGP 解密正文）")
    print("       用 python proton_register.py --recovery-email 可设置恢复邮箱")
    print()

    # ── 自动生成用户名 & 密码 ──
    username = _gen_username()
    password = _gen_password()
    print(f"  ✦ 随机用户名：{username}@proton.me")
    print(f"  ✦ 随机密码  ：{password}")
    print()

    verify_email = input("接收验证码的外部邮箱: ").strip()
    if not verify_email:
        print("[错误] 验证邮箱不能为空")
        sys.exit(1)

    print()
    print("[提示] 正在开始注册流程，验证码将在需要时自动发送并暂停等待你输入...")
    print()

    try:
        result = register_proton(
            username=username,
            password=password,
            verify_email=verify_email,
        )
        print(f"\n最终结果：")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        # 提示保存取件/续期凭证（不回显完整令牌，提醒落盘）
        if result.get("access_token") or result.get("refresh_token"):
            print("\n[提示] 已捕获会话令牌（access_token / refresh_token），")
            print("       取件或续期会话时会用到。access_token 以 ExpiresIn 为准，")
            print("       实测通常为 86400 秒；浏览器 cookie 可持久化约一年，")
            print("       但 refresh_token 每次 /api/auth/refresh 后都会轮换。")
            print("       如需持久保存，请将上述 JSON 结果保存到安全位置（含 password）。")
        else:
            print("\n[警告] 未能从 /auth 响应捕获会话令牌，取件功能可能受限。")
    except Exception as e:
        print(f"\n[错误] {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ("--mail", "-m"):
        main_mail()
    elif len(sys.argv) > 1 and sys.argv[1] in ("--recovery-email", "--recovery", "-r"):
        main_recovery_email()
    else:
        main()
