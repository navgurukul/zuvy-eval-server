import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { ClassSerializerInterceptor } from '@nestjs/common';

const { PORT, BASE_URL } = process.env;

async function bootstrap() {

  const corsOptions: CorsOptions = {
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  };

  const app = await NestFactory.create(AppModule);
  app.enableCors(corsOptions);

  const reflector = app.get(Reflector);
  app.useGlobalInterceptors(new ClassSerializerInterceptor(reflector));

  const config = new DocumentBuilder()
    .setTitle('Zuvy Eval API Docs')
    .setDescription(`[Base url: ${BASE_URL}]`)
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  await app.listen(PORT ?? 3000);
  console.log(`🚀 Server running → http://localhost:${PORT ?? 3000}`);
  console.log(`📘 Swagger Docs → http://localhost:${PORT ?? 3000}/api`);
}

bootstrap();
