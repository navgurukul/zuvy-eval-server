import {
  Controller,
  Body,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { TopicService } from './topic.service';
import { CreateTopicDto } from './dto/create-topic.dto';
import { UpdateTopicDto } from './dto/update-topic.dto';
import {
  createTopicExample,
  updateTopicExample,
} from './swagger_examples/examples';

@ApiTags('Topic')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('topic')
export class TopicController {
  constructor(private readonly topicService: TopicService) {}

  @Post()
  @ApiOperation({ summary: 'Create a topic' })
  @ApiBody({
    type: CreateTopicDto,
    examples: {
      basicExample: {
        summary: 'Create a new topic',
        value: createTopicExample,
      },
    },
  })
  create(
    @Body() createTopicDto: CreateTopicDto,
  ) {
    return this.topicService.create(createTopicDto);
  }

  @Get()
  @ApiOperation({ summary: 'List topics' })
  findAll() {
    return this.topicService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single topic' })
  findOne(
    @Param('id') id: string,
  ) {
    return this.topicService.findOne(+id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a topic' })
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
    @Param('id') id: string,
    @Body() updateTopicDto: UpdateTopicDto,
  ) {
    return this.topicService.update(+id, updateTopicDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a topic' })
  remove(
    @Param('id') id: string,
  ) {
    return this.topicService.remove(+id);
  }
}
