import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError, from } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { API } from '../configs/api.config';

export interface ImageUploadResponse {
  status: number;
  message: string;
  data: {
    url: string;
    path: string,
    size: number,
    content_type: string
  };
}

@Injectable({
  providedIn: 'root'
})
export class FeedbackService {

  constructor(private http: HttpClient) { }

  submitFeedback(data: any): Observable<any> {
    return this.http.post(API.feedback, data).pipe(
      catchError(this.handleError)
    );
  }

  /**
   * 上传图片到服务器
   * @param file 图片文件
   * @returns Observable<ImageUploadResponse>
   */
  uploadImage(file: File): Observable<ImageUploadResponse> {
    const formData = new FormData();
    formData.append('file', file, file.name);

    return this.http.post<ImageUploadResponse>(API.feedbackImageUpload, formData).pipe(
      catchError(this.handleError)
    );
  }

  private handleError(error: HttpErrorResponse): Observable<never> {
    console.error('FeedbackService error:', error);
    return throwError('Feedback submission failed');
  }
}
