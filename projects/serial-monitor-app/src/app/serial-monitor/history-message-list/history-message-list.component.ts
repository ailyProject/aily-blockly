import { Component, EventEmitter, Output } from '@angular/core';
import { SerialMonitorService } from '../../services/serial-monitor.service';
import { SimplebarAngularModule } from 'simplebar-angular';

@Component({
  selector: 'app-history-message-list',
  imports: [SimplebarAngularModule],
  templateUrl: './history-message-list.component.html',
  styleUrl: './history-message-list.component.scss'
})
export class HistoryMessageListComponent {

  @Output() value = new EventEmitter<string>();
  @Output() send = new EventEmitter<string>();
  @Output() close = new EventEmitter<void>();

  constructor(private serialMonitorService: SerialMonitorService) { }


  get sendHistoryList() {
    return this.serialMonitorService.sendHistoryList;
  }

  editHistory(content: string) {
    this.value.emit(content);
  }

  resendHistory(content: string) {
    this.send.emit(content);
  }

  onClose() {
    this.close.emit();
    console.log('close');
    
  }
}
