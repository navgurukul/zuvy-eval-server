import {
  BadRequestException,
  Controller,
  Body,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { TopicService } from './topic.service';
import { CreateTopicDto } from './dto/create-topic.dto';
import { UpdateTopicDto } from './dto/update-topic.dto';
import { createTopicExample, updateTopicExample } from './swagger_examples/examples';

@ApiTags('Topic')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('topic')
export class TopicController {
  constructor(private readonly topicService: TopicService) {}

  private parseBootcampId(bootcampId: string): string {
    const parsed = bootcampId?.trim();
    if (!parsed) {
      throw new BadRequestException('Valid bootcampId query param is required');
    }
    return parsed;
  }

  @Post()
  @ApiOperation({ summary: 'Create topic under a module' })
  @ApiQuery({
    name: 'bootcampId',
    required: true,
    type: String,
    example: '803',
    description: 'Bootcamp id under which the module/topic belongs',
  })
  @ApiBody({
    type: CreateTopicDto,
    examples: {
      basicExample: {
        summary: 'Create a new topic under module',
        value: createTopicExample,
      },
    },
  })
  create(
    @Req() req: Request & { user?: { orgId?: string | number } },
    @Query('bootcampId') bootcampId: string,
    @Body() createTopicDto: CreateTopicDto,
  ) {
    const orgId = req.user?.orgId;
    return this.topicService.create(
      this.parseBootcampId(bootcampId),
      orgId ?? '',
      createTopicDto,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List topics in a bootcamp' })
  @ApiQuery({
    name: 'bootcampId',
    required: true,
    type: String,
    example: '803',
    description: 'Bootcamp id for filtering topics',
  })
  findAll(
    @Req() req: Request & { user?: { orgId?: string | number } },
    @Query('bootcampId') bootcampId: string,
  ) {
    const orgId = req.user?.orgId;
    return this.topicService.findAll(this.parseBootcampId(bootcampId), orgId ?? '');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single topic in a bootcamp' })
  @ApiQuery({
    name: 'bootcampId',
    required: true,
    type: String,
    example: '803',
    description: 'Bootcamp id for topic ownership check',
  })
  findOne(
    @Req() req: Request & { user?: { orgId?: string | number } },
    @Query('bootcampId') bootcampId: string,
    @Param('id') id: string,
  ) {
    const orgId = req.user?.orgId;
    return this.topicService.findOne(
      this.parseBootcampId(bootcampId),
      orgId ?? '',
      +id,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a topic in a bootcamp' })
  @ApiQuery({
    name: 'bootcampId',
    required: true,
    type: String,
    example: '803',
    description: 'Bootcamp id for topic ownership check',
  })
  @ApiBody({
    type: UpdateTopicDto,
    examples: {
      renameTopic: {
        summary: 'Update topic title/description',
        value: updateTopicExample,
      },
    },
  })
  update(
    @Req() req: Request & { user?: { orgId?: string | number } },
    @Query('bootcampId') bootcampId: string,
    @Param('id') id: string,
    @Body() updateTopicDto: UpdateTopicDto,
  ) {
    const orgId = req.user?.orgId;
    return this.topicService.update(
      this.parseBootcampId(bootcampId),
      orgId ?? '',
      +id,
      updateTopicDto,
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a topic in a bootcamp' })
  @ApiQuery({
    name: 'bootcampId',
    required: true,
    type: String,
    example: '803',
    description: 'Bootcamp id for topic ownership check',
  })
  remove(
    @Req() req: Request & { user?: { orgId?: string | number } },
    @Query('bootcampId') bootcampId: string,
    @Param('id') id: string,
  ) {
    const orgId = req.user?.orgId;
    return this.topicService.remove(this.parseBootcampId(bootcampId), orgId ?? '', +id);
  }
}
