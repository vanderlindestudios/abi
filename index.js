require("dotenv").config();

const API_KEY = process.env.ROBLOX_API_KEY;
const GROUP_ID = process.env.GROUP_ID;

const BASE_URL = "https://apis.roblox.com/cloud/v2";

if (!API_KEY) {
    console.error("ROBLOX_API_KEY bulunamadı.");
    process.exit(1);
}

if (!GROUP_ID) {
    console.error("GROUP_ID bulunamadı.");
    process.exit(1);
}

const headers = {
    "x-api-key": API_KEY,
    "Content-Type": "application/json"
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(url, options = {}, retries = 4) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    ...headers,
                    ...(options.headers || {})
                }
            });

            const text = await response.text();

            let data;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = text;
            }

            if (response.ok) {
                return {
                    ok: true,
                    status: response.status,
                    data
                };
            }

            if (response.status === 429) {
                const retryAfter =
                    Number(response.headers.get("retry-after")) || 5;

                console.log(
                    `[RATE LIMIT] ${retryAfter} saniye bekleniyor...`
                );

                await sleep(retryAfter * 1000);
                continue;
            }

            if (response.status >= 500 && attempt < retries) {
                await sleep(attempt * 2000);
                continue;
            }

            return {
                ok: false,
                status: response.status,
                data
            };
        } catch (error) {
            if (attempt === retries) {
                return {
                    ok: false,
                    status: 0,
                    data: error.message
                };
            }

            await sleep(attempt * 2000);
        }
    }

    return {
        ok: false,
        status: 0,
        data: "Unknown error"
    };
}

function extractId(value) {
    if (value === undefined || value === null) {
        return null;
    }

    if (typeof value === "number") {
        return String(value);
    }

    if (typeof value === "object") {
        if (value.id !== undefined) {
            return String(value.id);
        }

        if (value.name !== undefined) {
            return extractId(value.name);
        }

        if (value.path !== undefined) {
            return extractId(value.path);
        }
    }

    const match = String(value).match(/(?:users|roles|memberships)\/([^/]+)$/);

    return match ? match[1] : null;
}

function getRoleId(role) {
    if (!role) return null;

    return extractId(
        role.id ??
        role.name ??
        role.path
    );
}

function getMembershipId(membership) {
    if (!membership) return null;

    return extractId(
        membership.id ??
        membership.name ??
        membership.path
    );
}

function getUserId(membership) {
    if (!membership) return null;

    return extractId(
        membership.userId ??
        membership.user?.id ??
        membership.user?.name ??
        membership.user
    );
}

function getMembershipRoleId(membership) {
    if (!membership) return null;

    return getRoleId(
        membership.role ??
        membership.roleId
    );
}

async function getAllPages(endpoint, collectionNames) {
    const results = [];
    let pageToken = "";

    while (true) {
        const url = new URL(`${BASE_URL}${endpoint}`);

        url.searchParams.set("maxPageSize", "100");

        if (pageToken) {
            url.searchParams.set("pageToken", pageToken);
        }

        const result = await request(url.toString());

        if (!result.ok) {
            throw new Error(
                `${result.status}: ${JSON.stringify(result.data)}`
            );
        }

        let items = [];

        for (const name of collectionNames) {
            if (Array.isArray(result.data?.[name])) {
                items = result.data[name];
                break;
            }
        }

        results.push(...items);

        pageToken =
            result.data?.nextPageToken ||
            result.data?.next_page_token ||
            "";

        if (!pageToken) {
            break;
        }
    }

    return results;
}

async function getRoles() {
    return getAllPages(
        `/groups/${GROUP_ID}/roles`,
        ["groupRoles", "roles"]
    );
}

async function getMemberships() {
    return getAllPages(
        `/groups/${GROUP_ID}/memberships`,
        ["groupMemberships", "memberships"]
    );
}

async function getUserName(userId) {
    if (!userId) return "Unknown";

    const result = await request(
        `${BASE_URL}/users/${userId}`
    );

    if (!result.ok) {
        return userId;
    }

    return (
        result.data?.displayName ||
        result.data?.name ||
        userId
    );
}

async function assignRole(membershipId, roleId) {
    const url =
        `${BASE_URL}/groups/${GROUP_ID}` +
        `/memberships/${membershipId}:assignRole`;

    return request(url, {
        method: "POST",
        body: JSON.stringify({
            role: `groups/${GROUP_ID}/roles/${roleId}`
        })
    });
}

async function main() {
    console.log("");
    console.log("========================================");
    console.log("       ROBLOX GROUP AUTO DEMOTER");
    console.log("========================================");
    console.log(`Group ID: ${GROUP_ID}`);
    console.log("");

    console.log("[1/3] Roller alınıyor...");

    const roles = await getRoles();

    if (!roles.length) {
        throw new Error("Grup rolleri alınamadı.");
    }

    const normalizedRoles = [];

    for (const role of roles) {
        const roleId = getRoleId(role);
        const rank = Number(role.rank ?? 0);

        if (!roleId || !Number.isFinite(rank)) {
            continue;
        }

        normalizedRoles.push({
            id: roleId,
            rank,
            name:
                role.displayName ||
                role.name ||
                roleId
        });
    }

    normalizedRoles.sort((a, b) => a.rank - b.rank);

    console.log(`Toplam rol: ${normalizedRoles.length}`);
    console.log("");

    console.log("[2/3] Üyeler alınıyor...");

    const memberships = await getMemberships();

    console.log(`Toplam üyelik: ${memberships.length}`);
    console.log("");

    console.log("[3/3] Üyeler işleniyor...");
    console.log("");

    let successCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (let i = 0; i < memberships.length; i++) {
        const membership = memberships[i];

        try {
            const membershipId = getMembershipId(membership);
            const userId = getUserId(membership);
            const currentRoleId = getMembershipRoleId(membership);

            if (!membershipId || !userId || !currentRoleId) {
                console.log(
                    `[SKIP] ${i + 1}/${memberships.length} - ` +
                    `Üyelik bilgisi eksik`
                );

                skippedCount++;
                continue;
            }

            const currentRole = normalizedRoles.find(
                role => role.id === currentRoleId
            );

            if (!currentRole) {
                console.log(
                    `[SKIP] ${i + 1}/${memberships.length} - ` +
                    `Mevcut rol bulunamadı (${currentRoleId})`
                );

                skippedCount++;
                continue;
            }

            if (currentRole.rank <= 1) {
                console.log(
                    `[SKIP] ${i + 1}/${memberships.length} - ` +
                    `${userId} zaten en düşük rütbede`
                );

                skippedCount++;
                continue;
            }

            const lowerRoles = normalizedRoles.filter(
                role =>
                    role.rank > 0 &&
                    role.rank < currentRole.rank
            );

            if (!lowerRoles.length) {
                console.log(
                    `[SKIP] ${i + 1}/${memberships.length} - ` +
                    `${userId} için alt rütbe bulunamadı`
                );

                skippedCount++;
                continue;
            }

            const targetRole =
                lowerRoles[lowerRoles.length - 1];

            const username = await getUserName(userId);

            console.log(
                `[${i + 1}/${memberships.length}] ` +
                `${username} | ` +
                `${currentRole.name} -> ${targetRole.name}`
            );

            const result = await assignRole(
                membershipId,
                targetRole.id
            );

            if (!result.ok) {
                console.log(
                    `   [ERROR] Atlandı | ` +
                    `${result.status} | ` +
                    `${JSON.stringify(result.data)}`
                );

                errorCount++;
                continue;
            }

            console.log("   [OK] Bir alt rütbeye indirildi.");

            successCount++;

            await sleep(300);
        } catch (error) {
            console.log(
                `   [ERROR] Üye atlandı | ${error.message}`
            );

            errorCount++;
        }
    }

    console.log("");
    console.log("========================================");
    console.log("              TAMAMLANDI");
    console.log("========================================");
    console.log(`Başarılı : ${successCount}`);
    console.log(`Atlandı  : ${skippedCount}`);
    console.log(`Hatalı   : ${errorCount}`);
    console.log(`Toplam   : ${memberships.length}`);
    console.log("========================================");
}

main().catch(error => {
    console.error("");
    console.error("SİSTEM HATASI:");
    console.error(error.message);
    process.exit(1);
});
