import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import {
  COMMUNITY_REPORT_STATES,
  COMMUNITY_REPORT_TARGET_TYPES,
} from "../community/community.types";
import { ROLE_KEYS } from "../identity/role-policy";
import { USER_STATUSES } from "../identity/identity.types";
import {
  AdminContentActionDto,
  AdminReportsQueryDto,
  AdminReplaceRolesDto,
  AdminResolveReportDto,
  AdminUserActionDto,
  AdminUsersQueryDto,
} from "./admin.dto";

describe("administration OpenAPI request contracts", () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it("describes actual enum strings and role-array constraints instead of object values", async () => {
    const module = await Test.createTestingModule({}).compile();
    app = module.createNestApplication();
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
      {
        extraModels: [
          AdminContentActionDto,
          AdminReportsQueryDto,
          AdminReplaceRolesDto,
          AdminResolveReportDto,
          AdminUserActionDto,
          AdminUsersQueryDto,
        ],
      },
    );
    const schemas = document.components!.schemas!;
    expect(schemas.AdminReportsQueryDto).toMatchObject({
      properties: {
        state: { type: "string", enum: Array.from(COMMUNITY_REPORT_STATES) },
        targetType: {
          type: "string",
          enum: Array.from(COMMUNITY_REPORT_TARGET_TYPES),
        },
      },
    });
    expect(schemas.AdminResolveReportDto).toMatchObject({
      required: ["state"],
      properties: {
        state: { type: "string", enum: Array.from(COMMUNITY_REPORT_STATES) },
      },
    });
    expect(schemas.AdminUsersQueryDto).toMatchObject({
      properties: {
        status: { type: "string", enum: Array.from(USER_STATUSES) },
        role: { type: "string", enum: Array.from(ROLE_KEYS) },
      },
    });
    expect(schemas.AdminReplaceRolesDto).toMatchObject({
      required: ["roles"],
      properties: {
        roles: {
          type: "array",
          minItems: 1,
          maxItems: ROLE_KEYS.length,
          uniqueItems: true,
          items: { type: "string", enum: Array.from(ROLE_KEYS) },
        },
      },
    });
    expect(schemas.AdminContentActionDto).toMatchObject({
      properties: {
        action: { type: "string", enum: ["HIDE", "REMOVE", "RESTORE"] },
      },
    });
    expect(schemas.AdminUserActionDto).toMatchObject({
      properties: {
        action: { type: "string", enum: ["WARN", "SUSPEND", "RESTORE"] },
      },
    });
  });
});
