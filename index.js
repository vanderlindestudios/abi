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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(url, options = {}, retries = 3) {
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

            let data = null;

            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = text;
            }

            if (response.ok) {
                return {
                    success: true,
                    status: response.status,
                    data
                };
            }

            if (response.status === 429) {
                const retryAfter = Number(response.headers.get("retry-after")) || 5;

                console.log(
                    `Rate limit. ${retryAfter} saniye bekleniyor...`
                );

                await sleep(retryAfter * 1000);
                continue;
            }

            if (response.status >= 500 && attempt < retries) {
                await sleep(attempt * 2000);
                continue;
            }

            return {
                success: false,
                status: response.status,
                data
            };
        } catch (error) {
            if (attempt >= retries) {
                return {
                    success: false,
                    status: 0,
                    data: error.message
                };
            }

            await sleep(attempt * 2000);
        }
    }

    return {
        success: false,
        status: 0,
        data: "Unknown error"
    };
}

async function getRoles() {
    const roles = [];
    let pageToken = "";

    while (true) {
        const url = new URL(
            `${BASE_URL}/groups/${GROUP_ID}/roles`
        );

        url.searchParams.set("pageSize", "100");

        if (pageToken) {
            url.searchParams.set("pageToken", pageToken);
        }

        const result = await request(url.toString());

        if (!result.success) {
            throw new Error(
                `Roller alınamadı: ${result.status} ${JSON.stringify(result.data)}`
            );
        }

        const pageRoles = result.data?.groupRoles || [];

        roles.push(...pageRoles);

        pageToken = result.data?.nextPageToken || "";

        if (!pageToken) {
            break;
        }
    }

    return roles;
}

async function getMemberships() {
    const memberships = [];
    let pageToken = "";

    while (true) {
        const url = new URL(
            `${BASE_URL}/groups/${GROUP_ID}/memberships`
        );

        url.searchParams.set("pageSize", "100");

        if (pageToken) {
            url.searchParams.set("pageToken", pageToken);
        }

        const result = await request(url.toString());

        if (!result.success) {
            throw new Error(
                `Üyeler alınamadı: ${result.status} ${JSON.stringify(result.data)}`
            );
        }

        const pageMemberships = result.data?.groupMemberships || [];

        memberships.push(...pageMemberships);

        pageToken = result.data?.nextPageToken || "";

        if (!pageToken) {
            break;
        }
    }

    return memberships;
}

function getRoleId(role) {
    if (!role) return null;

    if (typeof role === "string") {
        const match = role.match(/roles\/(\d+)/);
        return match ? match[1] : null;
    }

    if (role.role) {
        return getRoleId(role.role);
    }

    if (role.name && role.id) {
        return String(role.id);
    }

    if (role.id) {
        return String(role.id);
    }

    if (role.roleId) {
        return String(role.roleId);
    }

    return null;
}

function getMembershipRoleId(membership) {
    if (!membership) return null;

    if (membership.role) {
        return getRoleId(membership.role);
    }

    if (membership.roleId) {
        return String(membership.roleId);
    }

    return null;
}

function getUserId(membership) {
    if (membership.user?.split("/").length) {
        const match = String(membership.user).match(/users\/(\d+)/);

        if (match) {
            return match[1];
        }
    }

    if (membership.userId) {
        return String(membership.userId);
    }

    return null;
}

function getMembershipId(membership) {
    if (membership.name) {
        const match = String(membership.name).match(
            /memberships\/([^/]+)$/
        );

        if (match) {
            return match[1];
        }

        return String(membership.name).split("/").pop();
    }

    if (membership.membershipId) {
        return String(membership.membershipId);
    }

    if (membership.id) {
        return String(membership.id);
    }

    return null;
}

async function getUsername(userId) {
    if (!userId) return "Unknown";

    const result = await request(
        `${BASE_URL}/users/${userId}`
    );

    if (!result.success) {
        return userId;
    }

    return result.data?.displayName ||
        result.data?.name ||
        userId;
}

async function demoteMember(membershipId, targetRoleId) {
    const url =
        `${BASE_URL}/groups/${GROUP_ID}/memberships/${membershipId}`;

    return await request(url, {
        method: "PATCH",
        body: JSON.stringify({
            role: `groups/${GROUP_ID}/roles/${targetRoleId}`
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

    console.log("[1/3] Grup rolleri alınıyor...");

    const roles = await getRoles();

    if (!roles.length) {
        throw new Error("Hiç rol bulunamadı.");
    }

    roles.sort((a, b) => {
        return Number(a.rank || 0) - Number(b.rank || 0);
    });

    console.log(`Toplam rol: ${roles.length}`);

    const roleMap = new Map();

    for (const role of roles) {
        const roleId = getRoleId(role);

        if (!roleId) continue;

        roleMap.set(roleId, role);
    }

    console.log("");
    console.log("[2/3] Grup üyeleri alınıyor...");

    const memberships = await getMemberships();

    console.log(`Toplam üyelik: ${memberships.length}`);
    console.log("");

    let successCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    console.log("[3/3] Üyeler işleniyor...");
    console.log("");

    for (let i = 0; i < memberships.length; i++) {
        const membership = memberships[i];

        try {
            const membershipId = getMembershipId(membership);
            const userId = getUserId(membership);
            const currentRoleId = getMembershipRoleId(membership);

            if (!membershipId || !userId || !currentRoleId) {
                console.log(
                    `[SKIP] ${i + 1}/${memberships.length} - Üyelik bilgisi eksik`
                );

                skippedCount++;
                continue;
            }

            const currentRole = roleMap.get(currentRoleId);

            if (!currentRole) {
                console.log(
                    `[SKIP] ${i + 1}/${memberships.length} - Rol bulunamadı (${currentRoleId})`
                );

                skippedCount++;
                continue;
            }

            const currentRank = Number(currentRole.rank || 0);

            if (currentRank <= 0) {
                console.log(
                    `[SKIP] ${i + 1}/${memberships.length} - ${userId} zaten en düşük rütbede`
                );

                skippedCount++;
                continue;
            }

            const lowerRoles = roles.filter(role => {
                const rank = Number(role.rank || 0);

                return rank < currentRank && rank > 0;
            });

            if (!lowerRoles.length) {
                console.log(
                    `[SKIP] ${i + 1}/${memberships.length} - ${userId} için alt rütbe yok`
                );

                skippedCount++;
                continue;
            }

            const targetRole = lowerRoles[lowerRoles.length - 1];
            const targetRoleId = getRoleId(targetRole);

            if (!targetRoleId) {
                console.log(
                    `[SKIP] ${i + 1}/${memberships.length} - Hedef rol ID bulunamadı`
                );

                skippedCount++;
                continue;
            }

            const username = await getUsername(userId);

            console.log(
                `[${i + 1}/${memberships.length}] ${username} | ` +
                `${currentRole.displayName || currentRole.name || currentRoleId} -> ` +
                `${targetRole.displayName || targetRole.name || targetRoleId}`
            );

            const result = await demoteMember(
                membershipId,
                targetRoleId
            );

            if (!result.success) {
                console.log(
                    `   [ERROR] Atlandı: ${result.status} ${JSON.stringify(result.data)}`
                );

                errorCount++;
                continue;
            }

            console.log("   [OK] Rütbe düşürüldü.");

            successCount++;

            await sleep(250);
        } catch (error) {
            console.log(
                `   [ERROR] Üye atlandı: ${error.message}`
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
