import { Component, EventEmitter, Input, Output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { CloudService } from '../services/cloud.service';
import { resizeImage, convertImageToWebP } from '../../../utils/img.utils';
import { NZ_DATE_CONFIG_DEFAULT } from 'ng-zorro-antd/i18n';

@Component({
  selector: 'app-cloud-project-editor',
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzInputModule,
    NzTagModule,
    NzIconModule
  ],
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.scss'
})
export class EditorComponent implements OnInit {

  @Output() close = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>(); // 保存成功事件
  @Input() projectData: any = {
    id: '',
    name: '',
    nickname: '',
    description: '',
    image: '',
    image_url: '',
    tags: []
  };

  selectedImageFile: File | null = null;
  imagePreviewUrl: string | null = null;

  // 标签相关
  tags: string[] = [];
  tagInputValue = '';
  availableColors = ['magenta', 'red', 'volcano', 'orange', 'gold', 'lime', 'green', 'cyan', 'blue', 'geekblue', 'purple'];

  constructor(
    private cloudService: CloudService,
    private message: NzMessageService
  ) {
  }

  ngOnInit() {
    // 在 ngOnInit 中初始化图片预览URL,此时 @Input 属性已经被正确设置
    this.imagePreviewUrl = this.projectData.image_url || null;
    // 初始化标签
    this.tags = JSON.parse(this.projectData.tags) || [];

    console.log("Edit Data: ", this.projectData);
  }

  // 标签相关方法
  handleClose(removedTag: string): void {
    this.tags = this.tags.filter(tag => tag !== removedTag);
  }

  handleTagInputKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.addTag();
    }
  }

  addTag(): void {
    const trimmedValue = this.tagInputValue.trim();
    if (trimmedValue && this.tags.indexOf(trimmedValue) === -1) {
      this.tags = [...this.tags, trimmedValue];
      this.tagInputValue = '';
    }
  }

  getTagColor(index: number): string {
    return this.availableColors[index % this.availableColors.length];
  }

  onClose() {
    this.close.emit();
  }

  onImageFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      
      // 验证文件类型
      if (!file.type.startsWith('image/')) {
        this.message.error('请选择图片文件');
        return;
      }
      
      // 验证文件大小 (5MB限制)
      if (file.size > 5 * 1024 * 1024) {
        this.message.error('图片文件大小不能超过5MB');
        return;
      }
      
      this.selectedImageFile = file;
      
      // 生成预览URL
      const reader = new FileReader();
      reader.onload = (e) => {
        this.imagePreviewUrl = e.target?.result as string;
      };
      reader.readAsDataURL(file);
    }
  }

  removeSelectedImage() {
    this.selectedImageFile = null;
    this.imagePreviewUrl = null;
    
    // 清空file input的值
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    if (fileInput) {
      fileInput.value = '';
    }
  }

  // 加载图片并返回HTMLImageElement
  private loadImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败'));
      
      reader.onload = (e) => {
        if (e.target?.result) {
          img.src = e.target.result as string;
        }
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
  }

  // 从Blob加载图片
  private loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('图片加载失败'));
      };
      
      img.src = url;
    });
  }

  async onSave() {
    // 验证必填字段
    if (!this.projectData.nickname || !this.projectData.nickname.trim()) {
      this.message.error('请输入项目名称');
      return;
    }

    // 准备更新数据
    const updateData: any = {
      nickname: this.projectData.nickname.trim(),
      description: this.projectData.description || '',
      doc_url: this.projectData.doc_url || '',
      tags: this.tags
    };

    // 如果选择了新图片，先进行压缩和格式转换
    if (this.selectedImageFile) {
      try {
        // 显示处理中的提示
        const processingMsg = this.message.loading('正在处理图片...', { nzDuration: 0 });
        
        // 获取原图尺寸
        const img = await this.loadImage(this.selectedImageFile);
        console.log('原图尺寸:', img.width, 'x', img.height);
        
        // 强制压缩图片到 500x250，使用填充模式（会裁剪以填满整个区域）
        const resizedBlob = await resizeImage(this.selectedImageFile, {
          width: 500,
          height: 250,
          maintainAspectRatio: false,
          resizeMode: 'fill', // 使用填充模式，保持宽高比但会裁剪
          quality: 0.85,
          format: 'webp'
        });
        
        // 验证压缩后的尺寸
        const resizedImg = await this.loadImageFromBlob(resizedBlob);
        console.log('压缩后尺寸:', resizedImg.width, 'x', resizedImg.height);
        console.log('压缩后文件大小:', (resizedBlob.size / 1024).toFixed(2), 'KB');
        
        // 移除加载提示
        this.message.remove(processingMsg.messageId);
        
        // 将 Blob 转换为 File 对象
        const webpFile = new File([resizedBlob], 'project-image.webp', { type: 'image/webp' });
        updateData.image = webpFile;
      } catch (error) {
        console.error('图片处理失败:', error);
        this.message.error('图片处理失败，请重试');
        return;
      }
    }

    // 保存逻辑
    this.cloudService.updateProject(this.projectData.id, updateData).subscribe({
      next: (res) => {
        if (res && res.status === 200) {
          this.message.success('项目更新成功');
          // 通知父组件更新成功，父组件会重新获取项目列表（包括最新的封面图）
          this.saved.emit();
          this.close.emit();
        } else {
          this.message.error('项目更新失败');
        }
      },
      error: (error) => {
        console.error('更新项目失败:', error);
        this.message.error('项目更新失败: ' + error);
      }
    });
  }
}
