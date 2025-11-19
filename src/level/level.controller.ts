import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiCreatedResponse,
  ApiParam,
  ApiBody,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { LevelService } from './level.service';
import { CreateLevelDto } from './dto/create-level.dto';
import { UpdateLevelDto } from './dto/update-level.dto';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';

@ApiTags('level')
@Controller('level')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
export class LevelController {
  constructor(private readonly levelService: LevelService) {}

  @Post()
  @ApiOperation({ summary: 'Create a level' })
  @ApiCreatedResponse({
    description: 'Level created successfully',
    type: CreateLevelDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid input' })
  @ApiBody({ type: CreateLevelDto })
  create(@Body() createLevelDto: CreateLevelDto) {
    return this.levelService.create(createLevelDto);
  }

  @Post('seed')
  @ApiOperation({ summary: 'Seed default levels' })
  @ApiResponse({ status: 200, description: 'Seed completed' })
  seed() {
    return this.levelService.seed();
  }

  @Get()
  @ApiOperation({ summary: 'Get all levels' })
  @ApiResponse({ status: 200, description: 'List of levels' })
  findAll() {
    return this.levelService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a level by id' })
  @ApiParam({ name: 'id', description: 'Level id', type: Number })
  @ApiResponse({ status: 200, description: 'Level found' })
  @ApiNotFoundResponse({ description: 'Level not found' })
  findOne(@Param('id') id: string) {
    return this.levelService.findOne(+id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a level by id' })
  @ApiParam({ name: 'id', description: 'Level id', type: Number })
  @ApiBody({ type: UpdateLevelDto })
  @ApiResponse({
    status: 200,
    description: 'Level updated',
    type: UpdateLevelDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid input' })
  update(@Param('id') id: string, @Body() updateLevelDto: UpdateLevelDto) {
    return this.levelService.update(+id, updateLevelDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a level by id' })
  @ApiParam({ name: 'id', description: 'Level id', type: Number })
  @ApiResponse({ status: 200, description: 'Level removed' })
  @ApiNotFoundResponse({ description: 'Level not found' })
  remove(@Param('id') id: string) {
    return this.levelService.remove(+id);
  }
}
