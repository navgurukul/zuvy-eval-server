import { Controller, Post, Body, UseGuards, HttpException, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { LlmService } from './llm.service';

@Controller('llm')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
export class LlmController {
  constructor(private readonly llmService: LlmService) {}

  @Post()
  async generateResponse(@Body('prompt') prompt: string) {
    if (!prompt?.trim()) {
      throw new HttpException('Prompt is required', HttpStatus.BAD_REQUEST);
    }

    try {
      return await this.llmService.generateCompletion(prompt);
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to generate response',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}