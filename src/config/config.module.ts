import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { buildConfiguration } from "./configuration";
import { validateEnvironment } from "./env.validation";

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (input) => buildConfiguration(validateEnvironment(input)),
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}
